import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as acorn from 'acorn';
import { REPO_ROOT } from './helpers/repo-model.ts';
import { pluginFolder } from '../scripts/lib/marketplace.mjs';

// ---------------------------------------------------------------------------
// The pii-tokenise plugin keeps a personal address out of the model's context
// while letting the operator hand one to a tool. One script on five hook
// events:
//
//   - PostToolUse swaps each address in a tool's output for a handle and
//     returns the result as `updatedToolOutput`. A built-in tool's rewrite that
//     does not match its output shape is dropped silently and the original goes
//     through, so the shape is what this file pins hardest.
//   - PreToolUse swaps handles in a tool's input back, byte for byte.
//   - UserPromptSubmit blocks a prompt carrying an address and hands the
//     operator the tokenised copy to send instead.
//   - SessionEnd deletes the vault, and SessionStart sweeps a crashed
//     session's.
//
// Driven as the real process, as Claude Code runs it. PII_VAULT_DIR points the
// vault at a temp dir so no run touches the real one.
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = join(REPO_ROOT, 'plugins/pii-tokenise');
const HOOK = join(PLUGIN_ROOT, 'hooks/pii-tokenise.mjs');

// Every child here inherits this environment. The script does nothing in a
// project that carries its own copy, and a session running these tests may
// name such a project.
delete process.env.CLAUDE_PROJECT_DIR;
const SESSION = '0e6f7c1a-5b7d-4f5e-9a1b-2c3d4e5f6a7b';
const EMAIL = ['jane.q.sample', 'inbox-fixture.org'].join('@');
const OTHER = ['sam.o-neil+tag', 'post-fixture.co.uk'].join('@');

let vaultDir: string;
beforeEach(() => { vaultDir = mkdtempSync(join(tmpdir(), 'pii-vault-test-')); });
afterEach(() => { rmSync(vaultDir, { recursive: true, force: true }); });

/** Run one hook event; `null` for an empty stdout (no rewrite). */
function run(event: Record<string, unknown>, session = SESSION): Record<string, any> | null {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: session, transcript_path: '/x.jsonl', cwd: '/w', ...event }),
    env: { ...process.env, PII_VAULT_DIR: vaultDir },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

const post = (tool_name: string, tool_response: unknown, tool_input: unknown = {}) =>
  run({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, tool_use_id: 'toolu_1' });
const pre = (tool_name: string, tool_input: unknown) =>
  run({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'toolu_2' });

// A handle carries its vault's mark before the digest: `<email:<mark>:<digest>>`.
const HANDLE = /<email:[0-9a-f]{6}:[0-9a-f]{4,64}>/;

// The documented output shape of each built-in tool (code.claude.com/docs/en/hooks,
// § PostToolUse), each carrying the address somewhere a real call puts one, and
// a validator for that shape. A validator names every field: a rewrite that
// adds, drops or retypes one is what Claude Code ignores.
type Validator = (v: any) => void;
const str = (v: unknown) => assert.equal(typeof v, 'string');
const num = (v: unknown) => assert.equal(typeof v, 'number');
const bool = (v: unknown) => assert.equal(typeof v, 'boolean');
const keys = (v: any, expected: string[]) => assert.deepEqual(Object.keys(v).sort(), [...expected].sort());

const TOOLS: Array<{ tool: string; response: unknown; validate: Validator }> = [
  {
    tool: 'Bash',
    response: { stdout: `userId\tfrom\nu-1\t${EMAIL}\n`, stderr: `warning: ${OTHER} bounced`, interrupted: false, isImage: false },
    validate: (v) => { keys(v, ['stdout', 'stderr', 'interrupted', 'isImage']); str(v.stdout); str(v.stderr); bool(v.interrupted); bool(v.isImage); },
  },
  {
    tool: 'Read',
    response: { type: 'text', file: { filePath: '/w/feedback.json', content: `{"from":"${EMAIL}"}`, numLines: 1, startLine: 1, totalLines: 1 } },
    validate: (v) => {
      keys(v, ['type', 'file']); assert.equal(v.type, 'text');
      keys(v.file, ['filePath', 'content', 'numLines', 'startLine', 'totalLines']);
      str(v.file.filePath); str(v.file.content); num(v.file.numLines); num(v.file.startLine); num(v.file.totalLines);
    },
  },
  {
    tool: 'Grep',
    response: { mode: 'content', numFiles: 1, filenames: [], content: `notes.md:3:contact ${EMAIL}`, numLines: 1 },
    validate: (v) => { keys(v, ['mode', 'numFiles', 'filenames', 'content', 'numLines']); str(v.mode); num(v.numFiles); assert.ok(Array.isArray(v.filenames)); str(v.content); num(v.numLines); },
  },
  {
    tool: 'Glob',
    response: { filenames: [`/w/exports/${EMAIL}.json`], durationMs: 4, numFiles: 1, truncated: false },
    validate: (v) => { keys(v, ['filenames', 'durationMs', 'numFiles', 'truncated']); v.filenames.forEach(str); num(v.durationMs); num(v.numFiles); bool(v.truncated); },
  },
  {
    tool: 'Write',
    response: { type: 'create', filePath: '/w/note.md', content: `to ${EMAIL}`, structuredPatch: [], originalFile: null },
    validate: (v) => { keys(v, ['type', 'filePath', 'content', 'structuredPatch', 'originalFile']); str(v.type); str(v.filePath); str(v.content); assert.ok(Array.isArray(v.structuredPatch)); assert.equal(v.originalFile, null); },
  },
  {
    tool: 'Edit',
    response: {
      filePath: '/w/note.md', oldString: 'to x', newString: `to ${EMAIL}`, originalFile: 'to x\n', userModified: false, replaceAll: false,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-to x', `+to ${EMAIL}`] }],
    },
    validate: (v) => {
      keys(v, ['filePath', 'oldString', 'newString', 'originalFile', 'structuredPatch', 'userModified', 'replaceAll']);
      str(v.filePath); str(v.oldString); str(v.newString); str(v.originalFile); bool(v.userModified); bool(v.replaceAll);
      keys(v.structuredPatch[0], ['oldStart', 'oldLines', 'newStart', 'newLines', 'lines']); v.structuredPatch[0].lines.forEach(str);
    },
  },
  {
    tool: 'WebFetch',
    response: { bytes: 2048, code: 200, codeText: 'OK', result: `Author: ${EMAIL}`, durationMs: 310, url: 'https://blog.test/post' },
    validate: (v) => { keys(v, ['bytes', 'code', 'codeText', 'result', 'durationMs', 'url']); num(v.bytes); num(v.code); str(v.codeText); str(v.result); num(v.durationMs); str(v.url); },
  },
  {
    tool: 'WebSearch',
    response: { query: 'jane doe', results: [{ tool_use_id: 's1', content: [{ title: 'Jane', url: 'https://a.test' }] }, `Reach her at ${EMAIL}`], durationSeconds: 1.2 },
    validate: (v) => { keys(v, ['query', 'results', 'durationSeconds']); str(v.query); assert.equal(v.results.length, 2); str(v.results[1]); num(v.durationSeconds); },
  },
  {
    tool: 'Agent',
    response: { status: 'completed', prompt: 'find the account', agentId: 'a1', content: [{ type: 'text', text: `The row belongs to ${EMAIL}.` }], totalDurationMs: 900, totalTokens: 1200, totalToolUseCount: 3, usage: { input_tokens: 1000, output_tokens: 200 } },
    validate: (v) => {
      keys(v, ['status', 'prompt', 'agentId', 'content', 'totalDurationMs', 'totalTokens', 'totalToolUseCount', 'usage']);
      keys(v.content[0], ['type', 'text']); str(v.content[0].text); num(v.totalTokens); keys(v.usage, ['input_tokens', 'output_tokens']);
    },
  },
  {
    tool: 'mcp__github__issue_read',
    response: [{ type: 'text', text: `{"body":"from ${EMAIL}"}` }],
    validate: (v) => { assert.ok(Array.isArray(v)); keys(v[0], ['type', 'text']); str(v[0].text); },
  },
];

describe('PostToolUse: every built-in shape survives the rewrite', () => {
  for (const { tool, response, validate } of TOOLS) {
    test(tool, () => {
      validate(response); // the fixture itself is the documented shape
      const out = post(tool, response);
      assert.ok(out, 'an address in the output is rewritten');
      assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
      const rewritten = out.hookSpecificOutput.updatedToolOutput;
      validate(rewritten);
      const text = JSON.stringify(rewritten);
      assert.ok(!text.includes(EMAIL) && !text.includes(OTHER), text);
      assert.match(text, HANDLE);
      assert.match(out.hookSpecificOutput.additionalContext, /pass it to tools as written/);
    });
  }
});

describe('the round trip', () => {
  test('an email survives PostToolUse → PreToolUse byte for byte', () => {
    const out = post('Bash', { stdout: `owner: ${EMAIL}\n`, stderr: '', interrupted: false, isImage: false });
    const handle = out!.hookSpecificOutput.updatedToolOutput.stdout.match(HANDLE)[0];
    assert.equal(out!.hookSpecificOutput.updatedToolOutput.stdout, `owner: ${handle}\n`);

    const back = pre('Edit', { file_path: '/w/a.md', old_string: `owner: ${handle}`, new_string: 'owner: redacted', replace_all: false });
    assert.deepEqual(back!.hookSpecificOutput.updatedInput, {
      file_path: '/w/a.md', old_string: `owner: ${EMAIL}`, new_string: 'owner: redacted', replace_all: false,
    });
    assert.equal(back!.hookSpecificOutput.permissionDecision, undefined, 'the swap grants nothing');
  });

  test('one address gets one handle for the session; another session cannot resolve it', () => {
    const a = post('Bash', { stdout: EMAIL, stderr: '', interrupted: false, isImage: false })!.hookSpecificOutput.updatedToolOutput.stdout;
    const b = post('Grep', { mode: 'content', numFiles: 1, filenames: [], content: `x ${EMAIL}`, numLines: 1 })!.hookSpecificOutput.updatedToolOutput.content;
    assert.equal(b, `x ${a}`);
    const elsewhere = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${a}` } }, 'another-session');
    assert.equal(elsewhere!.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(elsewhere!.hookSpecificOutput.updatedInput, undefined);
  });

  test('a Bash command that hands over an address marks it for the script it runs', () => {
    const handle = post('Bash', { stdout: EMAIL, stderr: '', interrupted: false, isImage: false })!.hookSpecificOutput.updatedToolOutput.stdout;
    const back = pre('Bash', { command: `node scripts/operator-x.mjs --email ${handle}`, description: 'x' });
    const command: string = back!.hookSpecificOutput.updatedInput.command;
    assert.ok(command.endsWith(`node scripts/operator-x.mjs --email ${EMAIL}`), command);

    // Run the marker prefix the way Bash would. The variable's name and the
    // digest are the contract a script reads to tell a handed-over address
    // from one typed raw, so both are pinned as literals.
    const env = spawnSync('bash', ['-c', `${command.slice(0, command.indexOf('node '))} printenv PII_HANDED_OVER`], { encoding: 'utf8' }).stdout.trim();
    assert.equal(env, createHash('sha256').update(EMAIL).digest('hex').slice(0, 32));
    assert.equal(back!.hookSpecificOutput.updatedInput.description, 'x');
  });

  test('input with no handle and output with no address are left alone', () => {
    assert.equal(pre('Bash', { command: 'git log -1' }), null);
    assert.equal(post('Bash', { stdout: 'no addresses here', stderr: '', interrupted: false, isImage: false }), null);
  });

  test('a handle from an earlier vault is refused as stale, even where its digest names someone now', () => {
    // A resumed or long-idle session keeps handles in its context that a new
    // vault did not mint. Digests are short, so one can collide with a live
    // handle; the vault's mark is what tells them apart.
    const old = post('Bash', { stdout: EMAIL, stderr: '', interrupted: false, isImage: false })!.hookSpecificOutput.updatedToolOutput.stdout;
    run({ hook_event_name: 'SessionEnd', reason: 'resume' });
    const victim = 'victim' + '@mail.co';
    const current = post('Bash', { stdout: victim, stderr: '', interrupted: false, isImage: false })!.hookSpecificOutput.updatedToolOutput.stdout;
    const [, oldMark, oldDigest] = old.match(/^<email:([0-9a-f]+):([0-9a-f]+)>$/)!;
    const [, mark] = current.match(/^<email:([0-9a-f]+):([0-9a-f]+)>$/)!;
    assert.notEqual(mark, oldMark, 'each vault mints under its own mark');
    // Force the collision: the live vault holds the old digest for the victim.
    const file = join(vaultDir, readdirSync(vaultDir)[0]!);
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify([`<email:${mark}:${oldDigest}>`, victim])}\n`);

    for (const [tool, input] of [
      ['Bash', { command: `node scripts/operator-x.mjs --email ${old}` }],
      ['Edit', { file_path: '/w/a.md', old_string: 'x', new_string: `to ${current} and ${old}`, replace_all: false }],
    ] as const) {
      const out = pre(tool, input)!;
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', tool);
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /stale/);
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /re-read/i, 'the model is told how to get a current handle');
      assert.ok(!JSON.stringify(out).includes(victim) && !JSON.stringify(out).includes(EMAIL), tool);
    }
    // The current vault's handle still resolves.
    assert.ok(pre('Bash', { command: `echo ${current}` })!.hookSpecificOutput.updatedInput.command.endsWith(`echo ${victim}`));
  });

  test('an unknown handle under this vault\'s mark is left as typed', () => {
    const known = post('Bash', { stdout: EMAIL, stderr: '', interrupted: false, isImage: false })!.hookSpecificOutput.updatedToolOutput.stdout;
    const [, mark, digest] = known.match(/^<email:([0-9a-f]+):([0-9a-f]+)>$/)!;
    const unknown = `<email:${mark}:${digest === 'beef' ? 'feed' : 'beef'}>`;
    assert.equal(pre('Bash', { command: `echo ${unknown}` }), null);
  });

  test('a handle passed to another model stays a handle: a subagent is an operator session too', () => {
    const handle = post('Bash', { stdout: EMAIL, stderr: '', interrupted: false, isImage: false })!.hookSpecificOutput.updatedToolOutput.stdout;
    // A Skill's args come back into this model's own context.
    for (const tool of ['Agent', 'Task', 'SendMessage', 'Skill']) {
      assert.equal(pre(tool, { description: 'x', prompt: `find the account of ${handle}`, message: `ask about ${handle}`, args: handle }), null, tool);
    }
  });

  test('concurrent first calls in a fresh session each tokenise, and every handle resolves', async () => {
    // Parallel tool calls run their hooks at once. The races are narrow, so
    // several fresh sessions each take a burst.
    for (let round = 0; round < 4; round++) {
      const session = `race-${round}`;
      const addresses = Array.from({ length: 24 }, (_, i) => `person${i}` + '@mail.co');
      const outputs = await Promise.all(addresses.map((address) => new Promise<string>((done) => {
        const child = spawn(process.execPath, [HOOK], { env: { ...process.env, PII_VAULT_DIR: vaultDir } });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', () => done(stdout));
        child.stdin.end(JSON.stringify({
          session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash',
          tool_response: { stdout: address, stderr: '', interrupted: false, isImage: false },
        }));
      })));
      outputs.forEach((stdout, i) => {
        assert.ok(stdout, `round ${round} call ${i} was tokenised, not failed open`);
        const handle = JSON.parse(stdout).hookSpecificOutput.updatedToolOutput.stdout;
        assert.match(handle, HANDLE);
        const back = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${handle}` } }, session);
        assert.equal(back?.hookSpecificOutput.updatedInput.command.endsWith(`echo ${addresses[i]}`), true, `round ${round} call ${i}'s handle resolves`);
      });
    }
  });

  test('concurrent calls whose addresses share a short handle each keep one of their own', async () => {
    // Addresses whose HMACs agree on four hex digits contend for one handle.
    // Hooks that read the vault before any of them appends must not all hand
    // it out: the vault keeps the first line, so the rest would resolve to
    // someone else's address.
    const key = 'ab'.repeat(32);
    const prefix = (a: string) => createHmac('sha256', key).update(a).digest('hex').slice(0, 4);
    const byPrefix = new Map<string, string[]>();
    let addresses: string[] = [];
    for (let i = 0; addresses.length < 12; i++) {
      const a = `p${i}` + '@mail.co';
      const list = byPrefix.get(prefix(a)) ?? [];
      list.push(a);
      byPrefix.set(prefix(a), list);
      if (list.length > addresses.length) addresses = list;
    }
    for (let round = 0; round < 3; round++) {
      const session = `collide-${round}`;
      const digest = createHash('sha256').update(session).digest('hex').slice(0, 32);
      writeFileSync(join(vaultDir, `${digest}.json`), `${JSON.stringify({ key })}\n`, { mode: 0o600 });
      // Start every hook, let each boot and block on stdin, then release them
      // together so their vault reads land before any append.
      const children = addresses.map(() => spawn(process.execPath, [HOOK], { env: { ...process.env, PII_VAULT_DIR: vaultDir } }));
      const closed = children.map((child) => new Promise<string>((done) => {
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.on('close', () => done(stdout));
      }));
      await new Promise((r) => setTimeout(r, 400));
      children.forEach((child, i) => child.stdin.end(JSON.stringify({
        session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash',
        tool_response: { stdout: addresses[i], stderr: '', interrupted: false, isImage: false },
      })));
      const outputs = await Promise.all(closed);
      const handles = outputs.map((stdout, i) => {
        assert.ok(stdout, `round ${round} call ${i} was tokenised, not failed open`);
        return JSON.parse(stdout).hookSpecificOutput.updatedToolOutput.stdout;
      });
      const back = run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${handles.join(' ')}` } }, session);
      assert.ok(back?.hookSpecificOutput.updatedInput.command.endsWith(`echo ${addresses.join(' ')}`), `round ${round}: every handle resolves to its own address`);
    }
  });
});

describe('what counts as an identifier', () => {
  const tokenised = (s: string) => {
    const out = post('Bash', { stdout: s, stderr: '', interrupted: false, isImage: false });
    return out ? out.hookSpecificOutput.updatedToolOutput.stdout : s;
  };

  test('reserved, bot and git-host addresses are not personal and pass through', () => {
    for (const s of [
      'alice@example.com', 'a@b.example', 'x@y.test', 'u@host.invalid', 'dev@localhost.localhost',
      'Co-Authored-By: Claude <noreply@anthropic.com>', 'no-reply@accounts.google.com',
      '12345+someone@users.noreply.github.com', 'git@github.com:owner/repo.git',
      'lodash@4.17.21', 'node_modules/@aws-sdk/client-s3', 'already <email:1a2b>',
    ]) assert.equal(tokenised(s), s);
  });

  test('a personal address is tokenised wherever it sits', () => {
    for (const s of [EMAIL, `<${EMAIL}>`, `"${EMAIL}",`, `mailto:${EMAIL}?subject=hi`, `From: Jane <${OTHER}>`]) {
      const t = tokenised(s);
      assert.doesNotMatch(t, /@/, t);
      assert.match(t, HANDLE);
    }
  });

  // `git diff` puts `+` or `-` hard against a line's first character, and both
  // are local-part characters, so a decorator line read as an address whose
  // local part was the diff marker alone.
  const DECORATORS = ['@contextlib.contextmanager', '@pytest.fixture', '@app.route', '@decorator.name'];

  test('a decorator behind a diff marker is not an address: a local part needs a letter or digit', () => {
    for (const mark of ['+', '-', '.', '_', '%', '+-', '--']) {
      for (const decorator of DECORATORS) assert.equal(tokenised(mark + decorator), mark + decorator);
    }
  });

  test('a diff keeps its decorator lines and still loses the address beside them', () => {
    const diff = (author: string) => [
      'diff --git a/session.py b/session.py',
      '@@ -1,6 +1,7 @@',
      ' import contextlib',
      `+AUTHOR = "${author}"`,
      '-@pytest.fixture',
      '+@contextlib.contextmanager',
      ' def session():',
      '     yield',
    ].join('\n');
    const t = tokenised(diff(EMAIL));
    const handle = t.match(HANDLE)?.[0];
    assert.ok(handle, t);
    assert.equal(t, diff(handle));
  });

  test('a local part with punctuation in it, ending it, or a leading underscore is one address', () => {
    for (const local of ['first.last+tag', 'j', '_jane', '__jane.q', 'jane_', 'jane-', 'j+', '7']) {
      const t = tokenised(`to ${[local, 'inbox-fixture.org'].join('@')} today`);
      assert.match(t, new RegExp(`^to ${HANDLE.source} today$`), t);
    }
  });

  // An address at the start of a diff line has the marker against it. Taken
  // into the handle, the marker makes a second handle for the same person,
  // and a tool handed that one writes to another mailbox.
  test('a diff marker against an address stays outside the handle, which is the address\'s own', () => {
    const own = tokenised(EMAIL);
    assert.match(own, new RegExp(`^${HANDLE.source}$`));
    for (const mark of ['+', '-', '++', '--', '+-', '-+', '.', '..', '+.', '_-', '%+']) {
      assert.equal(tokenised(mark + EMAIL), mark + own);
    }
    const diff = (address: string) => [
      'diff --git a/CODEOWNERS b/CODEOWNERS',
      '@@ -1,2 +1,2 @@',
      ` ${address} docs/`,
      `-${address}`,
      `+${address} src/`,
    ].join('\n');
    assert.equal(tokenised(diff(EMAIL)), diff(own));
  });

  test('the marker survives the round trip: the tool gets the line the diff held', () => {
    const line = `+${EMAIL}`;
    const read = tokenised(line);
    assert.equal(pre('Write', { file_path: '/w/patch.diff', content: read })!.hookSpecificOutput.updatedInput.content, line);
  });
});

describe('the hooks module (Claude Code function hooks, early access)', () => {
  // Loaded where a session runs with CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1. It
  // rewrites the prompt before the model sees it, through the script, so the
  // handles land in the vault the tool hooks read. Driven here with a stand-in
  // for Claude Code's `$` whose process.run runs the real script.
  const PLUGIN = join(PLUGIN_ROOT, 'hooks/register.js');
  type Event = { text: string; origin?: { kind: string } };
  type Next = (e: Event) => unknown;
  type Hook = ($: unknown, e: Event, next: Next) => Promise<unknown>;

  const load = async () => {
    const hooks = new Map<string, Hook>();
    const mod = await import(PLUGIN);
    mod.register((event: string, hook: Hook) => { hooks.set(event, hook); });
    return hooks;
  };
  const engine = (
    run: (argv: readonly string[], init: { stdin?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  ) => ({
    session: { id: async () => SESSION },
    process: { run },
    plugin: { name: 'pii-tokenise', root: PLUGIN_ROOT },
  });
  // Runs argv as given from a directory that is not the plugin's:
  // $.process.run's default cwd is the session's, which is the project the
  // session works on.
  const runWithVault = (vault: () => string) => async (argv: readonly string[], init: { stdin?: string }) => {
    const [cmd, ...args] = argv;
    const res = spawnSync(cmd!, args, {
      input: init.stdin, cwd: vaultDir, encoding: 'utf8',
      env: { ...process.env, PII_VAULT_DIR: vault(), PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
    });
    return { exitCode: res.status ?? 1, stdout: res.stdout, stderr: res.stderr };
  };
  const realRun = runWithVault(() => vaultDir);
  const failures = [
    async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }),
    async () => ({ exitCode: 0, stdout: 'not json', stderr: '' }),
    async () => { throw new Error('cannot start'); },
  ];
  const submit = async ($: unknown, text: string) => {
    const hook = (await load()).get('prompt.submit')!;
    let passed: { text: string } | undefined;
    await hook($, { text }, (e) => { passed = e; return e; });
    return passed;
  };

  test('passes the prompt on with each address as a handle the tool hooks resolve', async () => {
    const passed = await submit(engine(realRun), `Grant 3 articles to ${EMAIL}, bad episode.`);
    assert.ok(passed, 'the prompt is passed on, never answered or dropped');
    assert.ok(!passed.text.includes(EMAIL), passed.text);
    const handle = passed.text.match(HANDLE)![0];
    assert.equal(passed.text, `Grant 3 articles to ${handle}, bad episode.`);
    assert.equal(pre('Bash', { command: `echo ${handle}` })!.hookSpecificOutput.updatedInput.command.endsWith(`echo ${EMAIL}`), true);
  });

  test('a prompt with no @ is passed on untouched, without running anything', async () => {
    let ran = false;
    const passed = await submit(engine(async () => { ran = true; return { exitCode: 0, stdout: '', stderr: '' }; }), 'grant 3 to userId u-1');
    assert.equal(passed!.text, 'grant 3 to userId u-1');
    assert.equal(ran, false);
  });

  test('if the script fails, the prompt goes on unchanged and the UserPromptSubmit hook blocks it', async () => {
    for (const run of failures) {
      const passed = await submit(engine(run), `to ${EMAIL}`);
      assert.equal(passed!.text, `to ${EMAIL}`);
    }
    assert.equal(run({ hook_event_name: 'UserPromptSubmit', prompt: `to ${EMAIL}` })!.decision, 'block');
  });

  // A delivery (a dispatcher relay into a local Desktop session, a peer's
  // message, a Remote Control prompt) is queued with the text session.receive
  // passes on. prompt.submit's rewrite of it reaches the settings hook but not
  // the model, so the delivery is rewritten here, before it is queued.
  const receive = async ($: unknown, text: string) => {
    const hook = (await load()).get('session.receive');
    assert.ok(hook, 'the plugin hooks session.receive');
    let passed: Event | undefined;
    await hook!($, { text, origin: { kind: 'peer' } }, (e) => { passed = e; return e; });
    assert.ok(passed, 'a delivery is passed on, never consumed');
    return passed!;
  };

  test('passes a delivery on with each address as a handle the tool hooks resolve', async () => {
    const passed = await receive(engine(realRun), `A comment on your pull request.\nTest: ${EMAIL}`);
    assert.ok(!passed.text.includes(EMAIL), passed.text);
    const handle = passed.text.match(HANDLE)![0];
    assert.equal(passed.text, `A comment on your pull request.\nTest: ${handle}`);
    assert.deepEqual(passed.origin, { kind: 'peer' }, 'origin passes on as received');
    assert.equal(pre('Bash', { command: `echo ${handle}` })!.hookSpecificOutput.updatedInput.command.endsWith(`echo ${EMAIL}`), true);
  });

  test('a delivery with no @ is passed on untouched, without running anything', async () => {
    let ran = false;
    const passed = await receive(engine(async () => { ran = true; return { exitCode: 0, stdout: '', stderr: '' }; }), 'PR #1 merged');
    assert.equal(passed.text, 'PR #1 merged');
    assert.equal(ran, false);
  });

  test('where no vault opens, a delivery goes on redacted: nobody may be there to re-send it', async () => {
    const blocked = join(vaultDir, 'not-a-dir');
    writeFileSync(blocked, '');
    const passed = await receive(engine(runWithVault(() => blocked)), `Test: ${EMAIL}`);
    assert.equal(passed.text, 'Test: <email:redacted>');
    // The delivery then passes UserPromptSubmit, which tells the model what
    // PostToolUse would: nothing resolves it.
    const note = run({ hook_event_name: 'UserPromptSubmit', prompt: passed.text })?.hookSpecificOutput.additionalContext;
    assert.match(note ?? '', /no tool can resolve it/);
  });

  test('a delivery whose @ is no personal address goes on unchanged, not held', async () => {
    const text = '@claude please look. Co-Authored-By: Claude <noreply@anthropic.com>';
    const passed = await receive(engine(realRun), text);
    assert.equal(passed.text, text);
  });

  test('a clean exit that prints nothing is nothing to rewrite, whether or not the engine sets stdout', async () => {
    const text = '@claude please look.';
    const silent = async () => ({ exitCode: 0, stderr: '' }) as unknown as { exitCode: number; stdout: string; stderr: string };
    assert.equal((await receive(engine(silent), text)).text, text);
    assert.equal((await submit(engine(silent), text))!.text, text);
  });

  test('if the script fails, the delivery becomes a notice that holds no address', async () => {
    // The plugin is loaded on purpose wherever it is loaded, so there is no
    // project in which a raw delivery is the right answer.
    for (const run of failures) {
      const passed = await receive(engine(run), `Test: ${EMAIL}, cc ${OTHER}`);
      assert.doesNotMatch(passed.text, /@/, passed.text);
      assert.match(passed.text, /Held back/);
    }
  });

  test('runs the script from the plugin\'s own folder, whatever project the session is in', async () => {
    // A delivered plugin sits in a skills folder, not in the project, so a
    // path relative to the session's directory would name nothing.
    const ran: string[][] = [];
    const recording = async (argv: readonly string[], init: { stdin?: string }) => { ran.push([...argv]); return realRun(argv, init); };
    await submit(engine(recording), `to ${EMAIL}`);
    await receive(engine(recording), `to ${EMAIL}`);
    assert.deepEqual(ran, [['node', HOOK], ['node', HOOK]]);
  });

  test('stays inside what the function-hook loader accepts: no imports, $ only as $.noun.member', () => {
    const ast = acorn.parse(readFileSync(PLUGIN, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    assert.ok(!ast.body.some((n) => n.type === 'ImportDeclaration'), 'the sandbox has no Node; an import stops the module loading');
    // Every `$` is the handler's parameter or the object of `$.noun`.
    const uses: string[] = [];
    const walk = (node: any, parent: any): void => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'Identifier' && node.name === '$') {
        const isParam = parent?.params?.includes(node);
        const isNoun = parent?.type === 'MemberExpression' && parent.object === node && !parent.computed;
        uses.push(isParam ? 'param' : isNoun ? 'noun' : `bare under ${parent?.type}`);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue;
        for (const child of Array.isArray(value) ? value : [value]) walk(child, node);
      }
    };
    walk(ast, null);
    assert.ok(uses.length > 1, 'the module calls through $');
    assert.deepEqual(uses.filter((u) => u !== 'param' && u !== 'noun'), []);
  });
});

describe('PromptRewrite: the script behind the plugin', () => {
  test('returns the tokenised prompt, and nothing for a prompt with no address', () => {
    const out = run({ hook_event_name: 'PromptRewrite', prompt: `to ${EMAIL}` });
    assert.match(out!.text, new RegExp(`^to ${HANDLE.source}$`));
    assert.equal(run({ hook_event_name: 'PromptRewrite', prompt: 'to u-1' }), null);
  });

  test('marks the vault live, like the other events of a running session', () => {
    const handle = run({ hook_event_name: 'PromptRewrite', prompt: `to ${EMAIL}` })!.text.slice(3);
    const file = join(vaultDir, readdirSync(vaultDir)[0]!);
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(file, old, old);
    run({ hook_event_name: 'PromptRewrite', prompt: `again ${EMAIL}` }); // nothing new to append
    run({ hook_event_name: 'SessionStart', source: 'startup' }, 'another-session');
    assert.equal(pre('Bash', { command: `echo ${handle}` })?.hookSpecificOutput.updatedInput.command.endsWith(`echo ${EMAIL}`), true);
  });
});

describe('UserPromptSubmit', () => {
  test('a prompt carrying an address is blocked, and the operator is handed the copy to send instead', () => {
    // Claude Code 2.1.283 drops additionalContext with a blocked prompt, and a
    // hook cannot replace a prompt; the block message reaches the operator only.
    const out = run({ hook_event_name: 'UserPromptSubmit', prompt: `Grant 3 articles to ${EMAIL}, they hit a bad episode.` });
    assert.equal(out!.decision, 'block');
    assert.equal(out!.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(out!.hookSpecificOutput.suppressOriginalPrompt, true, 'read only from hookSpecificOutput');
    const reason = String(out!.reason);
    assert.ok(!JSON.stringify(out).includes(EMAIL), 'no field names the address');
    const handle = reason.match(HANDLE)![0];
    assert.ok(reason.endsWith(`Grant 3 articles to ${handle}, they hit a bad episode.`), 'the copy is the prompt alone');
    // A title set here does not stop Claude Code titling from the prompt, and
    // would rename the session on every paste.
    assert.equal(out!.hookSpecificOutput.sessionTitle, undefined);

    // …the re-sent copy passes, carrying what a handle is to the model…
    const resent = run({ hook_event_name: 'UserPromptSubmit', prompt: `Grant 3 articles to ${handle}` });
    assert.equal(resent!.decision, undefined, 'not blocked');
    assert.match(resent!.hookSpecificOutput.additionalContext, /pass it to tools as written/);
    // …and the handle resolves.
    assert.equal(pre('Bash', { command: `echo ${handle}` })!.hookSpecificOutput.updatedInput.command.endsWith(`echo ${EMAIL}`), true);
  });

  test('a prompt with no address and no handle passes untouched', () => {
    assert.equal(run({ hook_event_name: 'UserPromptSubmit', prompt: 'grant 3 to userId u-1' }), null);
    assert.equal(run({ hook_event_name: 'UserPromptSubmit', prompt: 'what does <email:zz> mean' }), null, 'not a handle');
  });
});

describe('the vault', () => {
  test('lives outside the repo, readable by the owner only, and dies with the session', () => {
    post('Bash', { stdout: EMAIL, stderr: '', interrupted: false, isImage: false });
    const files = readdirSync(vaultDir);
    assert.equal(files.length, 1);
    const file = join(vaultDir, files[0]!);
    assert.equal(statSync(file).mode & 0o077, 0, 'no group or other bits');
    assert.ok(readFileSync(file, 'utf8').includes(EMAIL));

    run({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    assert.equal(existsSync(file), false);
  });

  test('defaults to the OS temp dir, not the project or ~/.claude', () => {
    const res = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(HOOK)}).then(m => console.log(m.vaultPath('s')))`], {
      env: { ...process.env, PII_VAULT_DIR: '' }, encoding: 'utf8',
    });
    const path = res.stdout.trim();
    assert.ok(path.startsWith(tmpdir()), path);
    assert.ok(!path.startsWith(REPO_ROOT), path);
  });

  test('SessionStart sweeps a vault a crashed session left behind', () => {
    const stale = join(vaultDir, 'crashed.json');
    const live = join(vaultDir, 'live.json');
    writeFileSync(stale, '{}');
    writeFileSync(live, '{}');
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(stale, old, old);
    run({ hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(live), true);
  });

  test('the sweep spares a live session whose last new address is older than a day', () => {
    // The vault's mtime moved only when a handle was appended; a session still
    // making tool calls is live whatever it last tokenised.
    const handle = post('Bash', { stdout: EMAIL, stderr: '', interrupted: false, isImage: false })!.hookSpecificOutput.updatedToolOutput.stdout;
    const file = join(vaultDir, readdirSync(vaultDir)[0]!);
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(file, old, old);
    assert.equal(pre('Bash', { command: 'git status' }), null);
    run({ hook_event_name: 'SessionStart', source: 'startup' }, 'another-session');
    assert.equal(pre('Bash', { command: `echo ${handle}` })?.hookSpecificOutput.updatedInput.command.endsWith(`echo ${EMAIL}`), true);
  });

  test('the sweep outlives an entry that vanishes under it', () => {
    // A dangling link stands in for a vault or temp file another session
    // removed between the listing and the stat.
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    const stale = Array.from({ length: 12 }, (_, i) => join(vaultDir, `crashed-${i}.json`));
    symlinkSync(join(vaultDir, 'gone'), join(vaultDir, 'a-vanished.json'));
    for (const f of stale) { writeFileSync(f, '{}'); utimesSync(f, old, old); }
    run({ hook_event_name: 'SessionStart', source: 'startup' });
    for (const f of stale) assert.equal(existsSync(f), false, f);
  });

  test('a session id cannot steer the vault out of its directory', () => {
    post('Bash', { stdout: EMAIL, stderr: '', interrupted: false, isImage: false });
    run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: EMAIL, stderr: '', interrupted: false, isImage: false } }, '../../escape');
    for (const f of readdirSync(vaultDir)) assert.doesNotMatch(f, /[/\\]|\.\./);
  });
});

test('fails closed where failing open leaks: a vault it cannot open redacts the address outright', () => {
  const blocked = join(vaultDir, 'not-a-dir');
  writeFileSync(blocked, '');
  const env = { ...process.env, PII_VAULT_DIR: blocked };
  const hook = (event: Record<string, unknown>) => {
    const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: SESSION, ...event }), env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };
  const out = hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: `to ${EMAIL}`, stderr: '', interrupted: false, isImage: false } });
  assert.equal(out.hookSpecificOutput.updatedToolOutput.stdout, 'to <email:redacted>');
  // A redacted address resolves nowhere: nothing may say the hook swaps it back.
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /swaps the address in/);
  const prompt = hook({ hook_event_name: 'UserPromptSubmit', prompt: `grant ${EMAIL}` });
  assert.equal(prompt.decision, 'block');
  assert.ok(!JSON.stringify(prompt).includes(EMAIL));
  assert.doesNotMatch(prompt.reason, /Send this instead|swaps the address in/, 'no copy the operator could send in vain');
  assert.match(prompt.reason, /by an id/, 'the operator is pointed at the route that still works');
  // The plugin's rewrite must not slip a redacted prompt past that block: the
  // model would read `<email:redacted>` unexplained and the operator hear nothing.
  const rewrite = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: 'PromptRewrite', prompt: `grant ${EMAIL}` }), env, encoding: 'utf8',
  });
  assert.equal(rewrite.status, 0, rewrite.stderr);
  assert.equal(rewrite.stdout, '', 'no rewrite, so the prompt goes on to the UserPromptSubmit block');
});

test('the default vault dir is per OS user, so another user cannot squat it', () => {
  const res = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(HOOK)}).then(m => console.log(m.vaultPath('s')))`], {
    env: { ...process.env, PII_VAULT_DIR: '' }, encoding: 'utf8',
  });
  assert.ok(res.stdout.includes(`pii-vault-${process.getuid!()}`), res.stdout);
});

test('fails open: unparseable input is a silent no-op, never a blocked tool', () => {
  const res = spawnSync(process.execPath, [HOOK], { input: 'not json', env: { ...process.env, PII_VAULT_DIR: vaultDir }, encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

describe('a project that carries its own copy of the hook', () => {
  // A repo may register the same script from its own checkout, at
  // .claude/hooks/pii-tokenise.mjs. Two copies with two vaults would each
  // refuse the other's handles as stale, so the plugin does nothing there and
  // the project's copy answers alone.
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'pii-project-'));
    mkdirSync(join(project, '.claude/hooks'), { recursive: true });
    writeFileSync(join(project, '.claude/hooks/pii-tokenise.mjs'), '');
  });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); });

  const EVENTS: Array<Record<string, unknown>> = [
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: EMAIL, stderr: '', interrupted: false, isImage: false } },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${['<email:0a1b2c', '7f3a>'].join(':')}` } },
    { hook_event_name: 'UserPromptSubmit', prompt: `to ${EMAIL}` },
    { hook_event_name: 'PromptRewrite', prompt: `to ${EMAIL}` },
    { hook_event_name: 'DeliveryRewrite', prompt: `to ${EMAIL}` },
  ];
  const runIn = (env: Record<string, string>, cwd: string, event: Record<string, unknown>) =>
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: SESSION, ...event }), cwd, encoding: 'utf8',
      env: { ...process.env, PII_VAULT_DIR: vaultDir, CLAUDE_PROJECT_DIR: '', ...env },
    });

  test('the plugin answers nothing on any event, and opens no vault', () => {
    for (const event of EVENTS) {
      // A command hook is told the project; the hooks module's run is not, and
      // starts in the session's directory.
      for (const res of [runIn({ CLAUDE_PROJECT_DIR: project }, vaultDir, event), runIn({}, project, event)]) {
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.stdout, '', String(event.hook_event_name));
      }
    }
    assert.deepEqual(readdirSync(vaultDir), []);
  });

  test('a project without one is served by the plugin', () => {
    rmSync(join(project, '.claude/hooks/pii-tokenise.mjs'));
    const res = runIn({ CLAUDE_PROJECT_DIR: project }, project, EVENTS[0]!);
    assert.match(JSON.parse(res.stdout).hookSpecificOutput.updatedToolOutput.stdout, HANDLE);
  });
});

test('no committed file carries a handle in the full grammar', () => {
  // The hook refuses any tool input carrying a handle this session's vault did
  // not mint. A committed example in the full grammar is such a handle in
  // every session, so no Edit, Write or grep that quotes it could run.
  // Examples stay outside the grammar (`<email:…:7f3a>`).
  const res = spawnSync('git', ['-C', REPO_ROOT, 'grep', '-I', '-n', '--untracked', '-E', HANDLE.source], { encoding: 'utf8' });
  // git grep exits 1 for no match, 0 for a match, anything else for an error.
  assert.ok(res.status === 0 || res.status === 1, res.stderr);
  assert.equal(res.stdout, '');
});

describe('the plugin', () => {
  const readJson = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8'));
  const COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/pii-tokenise.mjs"';

  test('the marketplace lists it, and its manifest carries the same name', () => {
    const entry = readJson('.claude-plugin/marketplace.json').plugins.find((p: { name: string }) => p.name === 'pii-tokenise');
    assert.ok(entry, 'pii-tokenise is listed');
    assert.equal(pluginFolder(entry), 'plugins/pii-tokenise');
    const manifest = readJson('plugins/pii-tokenise/.claude-plugin/plugin.json');
    assert.equal(manifest.name, 'pii-tokenise');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  });

  test('the script is registered on every event it serves, for every tool', () => {
    const { hooks } = readJson('plugins/pii-tokenise/hooks/hooks.json');
    assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    for (const [event, groups] of Object.entries(hooks) as Array<[string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>]>) {
      assert.equal(groups.length, 1, event);
      assert.equal(groups[0]!.matcher, undefined, `${event} matches every tool`);
      const [hook, ...rest] = groups[0]!.hooks;
      assert.equal(rest.length, 0, `${event} runs one hook`);
      assert.equal(hook!.type, 'command');
      assert.equal(hook!.command, COMMAND);
      // A rewrite the tool waits for: never async, and bounded.
      assert.notEqual(hook!.async, true, event);
      assert.equal(hook!.timeout, event === 'SessionEnd' ? 5 : 10);
    }
  });

  test('the hooks module is listed beside the command hooks, and exists', () => {
    const { modules } = readJson('plugins/pii-tokenise/hooks/hooks.json');
    assert.deepEqual(modules, ['./register.js']);
    assert.ok(existsSync(join(PLUGIN_ROOT, 'hooks/register.js')));
  });

  test('the folder is self-contained: the script imports nothing outside node', () => {
    // plugin-sources delivers the plugin's folder alone, so an import that
    // climbs out of it resolves in this repo and nowhere else.
    const ast = acorn.parse(readFileSync(HOOK, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    const sources = ast.body.filter((n) => n.type === 'ImportDeclaration').map((n: any) => String(n.source.value));
    assert.ok(sources.length > 0);
    assert.deepEqual(sources.filter((source) => !source.startsWith('node:')), []);
  });
});
