#!/usr/bin/env node
/**
 * The tokenising hook. A personal address reaches the model only as a handle
 * (`<email:…:7f3a>`). One script on five events, registered in hooks.json:
 *
 *   - PostToolUse: every address in a tool's output becomes a handle, and the
 *     output goes back as `updatedToolOutput`. Only string leaves change, so
 *     the rewrite keeps the tool's output shape; a built-in tool's rewrite
 *     that does not is dropped silently and the original goes through.
 *   - PreToolUse: every handle in a tool's input becomes its address again, via
 *     `updatedInput`, so the tool gets the address the model never saw. A
 *     handle under another vault's mark is refused as stale. A Bash
 *     command also gets `export PII_HANDED_OVER=…;` in front, which a script
 *     reads to tell a handed-over value from a raw one (README, "Scripts that
 *     take an address"). Input another model reads (a subagent's prompt, a
 *     skill's args) keeps its handles.
 *   - UserPromptSubmit: a prompt carrying an address is blocked, and the block
 *     message hands the operator its tokenised copy to send instead.
 *   - PromptRewrite and DeliveryRewrite, not Claude Code events, serve the
 *     hooks module (register.js): where function hooks are on, it tokenises a
 *     typed prompt (prompt.submit) or a delivery such as a relayed message
 *     (session.receive) before the model sees it, and the block above never
 *     fires.
 *   - SessionEnd deletes this session's vault; SessionStart sweeps any a
 *     crashed session left behind.
 *
 * The vault maps handles to addresses, one append-only file per session in the
 * OS temp dir: outside the project and outside ~/.claude, where transcripts
 * live. Each vault mints its handles under a mark derived from its key. A
 * resumed or long-idle session keeps handles from a vault since deleted, and a
 * digest is short enough to collide; the mark makes such a handle fail loudly
 * rather than resolve to whoever the new vault gave that digest.
 *
 * Where this fails open: a tool failure goes through PostToolUseFailure, which
 * cannot rewrite; a session that has not loaded the plugin has no hook; and
 * any other error here exits 0 with no output, so the tool runs untouched.
 * Where no vault can be used, an address is redacted to `<email:redacted>`
 * instead. The hook narrows what the model sees. It is not an access control.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The contract with a script that takes an address (README, "Scripts that take
// an address"). A script holds its own copy of these three, so a change to any
// of them is a breaking release.
//
// The handle grammar: the minting vault's mark, then the address's digest
// under that vault's key.
const EMAIL_HANDLE_SOURCE = '<email:[0-9a-f]{6}:[0-9a-f]{4,64}>';
// What the hook writes when it has no vault to hold the address: resolvable by nobody.
const REDACTED_EMAIL = '<email:redacted>';
// The variable a Bash command carries: one digest per address swapped into it.
const HANDED_OVER_ENV = 'PII_HANDED_OVER';
/**
 * A digest of the value, not the value: the marker sits in the command line
 * beside the address it names, so it adds no exposure, but it keeps the address
 * out of any child process that only inherits the environment.
 * @param {string} value
 */
const handedOverDigest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** @typedef {{ key: string, mark: string, handles: Record<string, string> }} Vault */

// A local part holds at least one letter or digit. Punctuation alone before the
// `@` is not an address: `git diff` writes an added decorator line as `+` hard
// against `@contextlib.contextmanager`, and the rest parses as a domain.
const EMAIL = /[._%+-]*[A-Za-z0-9][A-Za-z0-9._%+-]*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}/g;
const EMAIL_HANDLE = new RegExp(EMAIL_HANDLE_SOURCE, 'g');

// Addresses that name no person: reserved names (RFC 2606, 6761), bot senders,
// and the `git@` of an SSH remote. Tokenising them costs every dev session
// legibility and protects nobody.
const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost']);
const RESERVED_DOMAINS = new Set(['example.com', 'example.org', 'example.net']);
const BOT_LOCAL_PARTS = new Set(['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'git']);

/** @param {string} address */
function isPersonal(address) {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.has(domain)) return false;
  if (domain.endsWith('.noreply.github.com')) return false;
  return !BOT_LOCAL_PARTS.has(local);
}

// The SessionStart sweep removes a vault untouched for a day; the events of a
// running session touch it.
const VAULT_TTL_MS = 24 * 3600 * 1000;
const LIVE_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PromptRewrite', 'DeliveryRewrite']);

/**
 * The vault directory: PII_VAULT_DIR for tests, else one per OS user in the
 * temp dir, so another user who made the directory first cannot lock this one
 * out of it.
 */
const vaultDir = () => process.env.PII_VAULT_DIR
  || join(tmpdir(), `pii-vault-${process.getuid?.() ?? 'user'}`);

/**
 * Keyed by a digest of the session id, so no id can name a path outside the dir.
 * @param {string} sessionId
 */
export const vaultPath = (sessionId) =>
  join(vaultDir(), `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`);

/**
 * The vault's mark, the first part of every handle it mints.
 * @param {string} key
 */
const markOf = (key) => createHmac('sha256', key).update('mark').digest('hex').slice(0, 6);

/**
 * The vault file is append-only: a `{"key":…}` line, then one `[handle,
 * address]` line per handle. Parallel tool calls run their hooks at once, and
 * a read-modify-write would drop one hook's handles; an append cannot.
 * @param {string} path
 * @returns {Vault}
 */
function readVault(path) {
  const [head = '', ...lines] = readFileSync(path, 'utf8').split('\n');
  const { key } = JSON.parse(head);
  /** @type {Vault} */
  const vault = { key, mark: markOf(key), handles: {} };
  for (const line of lines) {
    try {
      const [handle, address] = JSON.parse(line);
      vault.handles[handle] ??= address;
    } catch { /* the empty tail, or a line a killed hook tore */ }
  }
  return vault;
}

/**
 * Read the session's vault, creating it with a fresh key if absent. The key
 * is written whole before the link makes it visible, so a hook racing on a
 * session's first call never reads a half-written vault, and the exclusive
 * link means both agree on one key.
 * @param {string} path
 * @returns {Vault}
 */
function openVault(path) {
  try {
    return readVault(path);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
  }
  mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ key: randomBytes(32).toString('hex') })}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, path);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  return readVault(path);
}

/**
 * Append new handles in one write. No create flag: a vault swept since it was
 * read is not recreated keyless.
 * @param {string} path
 * @param {Record<string, string>} added
 */
function appendHandles(path, added) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND);
  try {
    writeSync(fd, Object.entries(added).map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  } finally {
    closeSync(fd);
  }
}

/**
 * A handle for the address: the vault's mark, then an HMAC under the session
 * key, four hex digits, lengthened only when a different address already
 * holds the shorter one.
 * @param {Vault} vault
 * @param {string} address
 */
function handleFor(vault, address) {
  const digest = createHmac('sha256', vault.key).update(address).digest('hex');
  for (let len = 4; len <= digest.length; len += 2) {
    const handle = `<email:${vault.mark}:${digest.slice(0, len)}>`;
    const held = vault.handles[handle];
    if (held === undefined || held === address) return handle;
  }
  throw new Error('handle space exhausted');
}

/**
 * Apply `fn` to every string leaf, leaving keys, numbers, booleans, nulls and
 * array lengths as they were: the output shape is the contract.
 * @param {unknown} value
 * @param {(s: string) => string} fn
 * @returns {unknown}
 */
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

/**
 * Replace every personal address in `value`'s strings with its handle.
 * @param {string} sessionId
 * @param {unknown} value
 * @returns {{ changed: boolean, value: unknown }}
 */
export function tokenise(sessionId, value) {
  const path = vaultPath(sessionId);
  for (;;) {
    /** @type {Vault | undefined} */
    let vault;
    /** @type {Record<string, string>} */
    const added = {};
    let changed = false;
    const out = mapStrings(value, (s) => s.replace(EMAIL, (address) => {
      if (!isPersonal(address)) return address;
      vault ??= openVault(path);
      const handle = handleFor(vault, address);
      if (vault.handles[handle] === undefined) {
        vault.handles[handle] = address;
        added[handle] = address;
      }
      changed = true;
      return handle;
    }));
    if (Object.keys(added).length === 0) return { changed, value: out };
    appendHandles(path, added);
    // A hook that read the vault alongside this one may have appended another
    // address under the same handle first, and the vault keeps the first line.
    // Then tokenise again: the re-read vault holds that line, so handleFor
    // lengthens past it.
    const held = readVault(path).handles;
    if (Object.entries(added).every(([h, address]) => held[h] === address)) return { changed, value: out };
  }
}

/**
 * Tokenise, or where the vault cannot be used, replace every personal address
 * with one handle nobody can resolve. Failing open here is the leak.
 * @param {string} sessionId
 * @param {unknown} value
 * @returns {{ changed: boolean, value: unknown, redacted: boolean }}
 */
function tokeniseOrRedact(sessionId, value) {
  try {
    return { ...tokenise(sessionId, value), redacted: false };
  } catch {
    let changed = false;
    const out = mapStrings(value, (s) => s.replace(EMAIL, (address) => {
      if (!isPersonal(address)) return address;
      changed = true;
      return REDACTED_EMAIL;
    }));
    return { changed, value: out, redacted: true };
  }
}

/**
 * Swap every handle the vault knows back to its address. A handle under
 * another mark is stale: no vault, or an earlier one, minted it.
 * @param {string} sessionId
 * @param {unknown} value
 * @returns {{ swapped: string[], stale: boolean, value: unknown }}
 */
export function detokenise(sessionId, value) {
  /** @type {Vault | null | undefined} null: no vault to read, so every handle is stale. */
  let vault;
  /** @type {string[]} */
  const swapped = [];
  let stale = false;
  const out = mapStrings(value, (s) => s.replace(EMAIL_HANDLE, (handle) => {
    if (vault === undefined) {
      try {
        vault = readVault(vaultPath(sessionId));
      } catch {
        vault = null;
      }
    }
    if (vault === null || !handle.startsWith(`<email:${vault.mark}:`)) {
      stale = true;
      return handle;
    }
    const address = vault.handles[handle];
    if (address === undefined) return handle;
    swapped.push(address);
    return address;
  }));
  return { swapped, stale, value: out };
}

// Tools whose input is read by a model, not run: a subagent's prompt, a
// message to another session, a skill's args. A handle stays a handle there.
// Known gap: every other tool gets the address, one that posts to a public
// system included (README, "What it does not cover").
const MODEL_READ_TOOLS = new Set(['Agent', 'Task', 'SendMessage', 'Skill']);

// What the model needs to use a handle, wherever one first reaches it.
const HANDLE_NOTE = '<email:…> is a handle for a personal address: pass it to tools as written, '
  + 'and the tokenising hook swaps the address in when the tool runs.';
// A stale handle names nobody now; the address has to come in again.
const STALE_NOTE = 'An <email:…> handle here is stale: a vault this session does not hold minted it (an earlier one, '
  + 'from before a resume or a long idle, or another session\'s), '
  + 'so it names nobody now. Re-read the address through a tool, or have the operator paste it '
  + 'again, and pass the handle it becomes.';
// With no vault an address is redacted, and nothing can swap it back.
const REDACTED_NOTE = `${REDACTED_EMAIL} is a personal address the tokenising hook could not store: `
  + 'no tool can resolve it, so name the person by an id instead.';

/**
 * A project may register this same script from its own checkout. Two copies
 * keep two vaults, and each PreToolUse would refuse the other's handles as
 * stale, so where the project has one, this copy does nothing. A command hook
 * is told the project; the hooks module's run starts in the session's
 * directory and is not.
 */
const projectHasOwnCopy = () =>
  existsSync(join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude/hooks/pii-tokenise.mjs'));

/**
 * One hook event in, the hook's JSON output (or nothing) out.
 * @param {Record<string, any>} input
 * @returns {object | undefined}
 */
export function handle(input) {
  if (projectHasOwnCopy()) return undefined;
  const session = String(input.session_id ?? '');
  if (LIVE_EVENTS.has(input.hook_event_name)) {
    // Mark the vault live, so another session's sweep spares it however long
    // ago its last handle was appended.
    try {
      const now = new Date();
      utimesSync(vaultPath(session), now, now);
    } catch { /* no vault yet */ }
  }
  switch (input.hook_event_name) {
    case 'PostToolUse': {
      const { changed, value, redacted } = tokeniseOrRedact(session, input.tool_response);
      if (!changed) return undefined;
      const additionalContext = redacted ? REDACTED_NOTE : HANDLE_NOTE;
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: value, additionalContext } };
    }
    case 'PreToolUse': {
      if (MODEL_READ_TOOLS.has(input.tool_name)) return undefined;
      const { swapped, stale, value } = detokenise(session, input.tool_input);
      if (stale) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STALE_NOTE } };
      }
      if (swapped.length === 0) return undefined;
      const updatedInput = /** @type {Record<string, unknown>} */ (value);
      if (input.tool_name === 'Bash' && typeof updatedInput.command === 'string') {
        const digests = [...new Set(swapped)].map(handedOverDigest).join(',');
        updatedInput.command = `export ${HANDED_OVER_ENV}=${digests}; ${updatedInput.command}`;
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } };
    }
    case 'UserPromptSubmit': {
      // A hook cannot replace a prompt, and a blocked prompt's additionalContext
      // never reaches the model (Claude Code 2.1.283). The block message goes to
      // the operator only, so it carries the tokenised copy for them to send.
      const prompt = String(input.prompt ?? '');
      const { changed, value, redacted } = tokeniseOrRedact(session, prompt);
      if (!changed) {
        // The re-sent copy, or a delivery the plugin tokenised or redacted: a
        // prompt that is let through does deliver its context.
        const notes = [
          ...(new RegExp(EMAIL_HANDLE_SOURCE).test(prompt) ? [HANDLE_NOTE] : []),
          ...(prompt.includes(REDACTED_EMAIL) ? [REDACTED_NOTE] : []),
        ];
        if (notes.length === 0) return undefined;
        return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notes.join('\n') } };
      }
      // A relayed prompt is tokenised by the hooks module's session.receive
      // hook, so it reaches this block only where function hooks are off, and
      // is held here rather than let through.
      const held = 'Held back: this prompt carried a personal address, which the model must not see.';
      return {
        decision: 'block',
        // A redacted copy resolves nowhere, so offering it would waste a turn.
        reason: redacted
          ? `${held} The handle vault could not be opened, so it cannot go in as a handle: name the person by an id instead.`
          : `${held} Send this instead:\n\n${value}`,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          // Read from here only; a top-level copy is ignored.
          suppressOriginalPrompt: true,
        },
      };
    }
    case 'PromptRewrite': {
      // Not a Claude Code event: the hooks module's prompt.submit hook calls
      // this so its handles land in the vault the tool hooks read. A redacted
      // copy is not sent: the prompt goes on unchanged and the UserPromptSubmit
      // block points the operator at an id.
      const { changed, value, redacted } = tokeniseOrRedact(session, String(input.prompt ?? ''));
      return changed && !redacted ? { text: value } : undefined;
    }
    case 'DeliveryRewrite': {
      // The session.receive half of the hooks module. A delivery may have nobody to
      // re-send it, so a redacted copy goes in rather than being held.
      const { changed, value } = tokeniseOrRedact(session, String(input.prompt ?? ''));
      return changed ? { text: value } : undefined;
    }
    case 'SessionEnd':
      rmSync(vaultPath(session), { force: true });
      return undefined;
    case 'SessionStart': {
      const now = Date.now();
      let names = [];
      try { names = readdirSync(vaultDir()); } catch { return undefined; }
      for (const name of names) {
        const path = join(vaultDir(), name);
        try {
          if (now - statSync(path).mtimeMs > VAULT_TTL_MS) rmSync(path, { force: true });
        } catch { /* removed under us by another session's sweep or SessionEnd */ }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Whether this module is the process entry point. `import.meta.url` and
 * `process.argv[1]` spell the same file two ways: the URL percent-encodes, and
 * node resolves the main module's symlinks for the URL but not for argv. A miss
 * is silent (nothing runs, exit 0), so both spellings are tried, exactly.
 */
function isCliEntry() {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    if (import.meta.url === pathToFileURL(argv1).href) return true;
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  try {
    const output = handle(JSON.parse(readFileSync(0, 'utf8')));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (err) {
    // Fail open: a broken hook must not block a tool. Stderr reaches the debug
    // log only; it never names the input.
    process.stderr.write(`pii-tokenise: ${/** @type {Error} */ (err).name}\n`);
  }
}
