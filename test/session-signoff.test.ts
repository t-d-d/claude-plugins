import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// The session-signoff plugin asks a session on the owner's own machine to
// archive itself once it has signed off.
//
// A dispatcher such as governor archives a session whose last reply ends with
// the sign-off line, and needs nothing in the repo for it. Two things it
// cannot do for a local session: its archive does not close the desktop app's
// window, and a local session without Remote Control is not on the list it
// reads. So one blocking Stop hook has the session call the desktop app's own
// archive tool, once. It writes nothing and makes no request: the dispatcher
// reads the sign-off from the session's own reply.
//
// Driven as the real process, as Claude Code runs it.
// ---------------------------------------------------------------------------

const PLUGIN = 'plugins/session-signoff';
const HOOK = join(REPO_ROOT, PLUGIN, 'hooks/session-signoff.sh');
const SIGN_OFF = 'Signing off.';
const ARCHIVE = 'mcp__ccd_session_mgmt__archive_session';
const SESSION = '7ca285bb-1bef-54b9-9968-fb7472cb526c';
const REMOTE_ID = 'cse_01DwUtvA7vD5J4ZiUnd9ifyc';

const readJson = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf-8'));

let dir: string;
let calls: string;

// A `curl` ahead of the real one on PATH, recording that it ran: a sign-off
// record would be a request, however the hook spelt it.
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'session-signoff-'));
  calls = join(dir, 'curl-calls.txt');
  mkdirSync(join(dir, 'bin'));
  const stub = join(dir, 'bin', 'curl');
  writeFileSync(stub, ['#!/bin/bash', 'printf "%s\\n" "$*" >> "$STUB_CALLS"', 'exit 0'].join('\n') + '\n');
  chmodSync(stub, 0o755);
});

after(() => rmSync(dir, { recursive: true, force: true }));

type Over = { message?: unknown; env?: Record<string, string | undefined>; input?: Record<string, unknown>; stdin?: string };

/** One Stop of a local session, unless `env` or `input` says otherwise. */
function stop({ message, env = {}, input = {}, stdin }: Over = {}) {
  rmSync(calls, { force: true });
  const result = spawnSync('bash', [HOOK], {
    input: stdin ?? JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION, cwd: dir, last_assistant_message: message, ...input }),
    encoding: 'utf-8',
    env: {
      PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`,
      HOME: dir,
      TMPDIR: dir,
      STUB_CALLS: calls,
      // A session running these tests may itself be a cloud session, or sit
      // in a project with its own copy of the hook.
      CLAUDE_CODE_REMOTE_SESSION_ID: undefined,
      CLAUDE_PROJECT_DIR: dir,
      ...env,
    },
  });
  return { result, requests: existsSync(calls) ? readFileSync(calls, 'utf-8').split('\n').filter(Boolean) : [] };
}

describe('session-signoff: a local session that signs off is asked, once, to archive itself', () => {
  test('its sign-off turn blocks the stop, naming the tool', () => {
    const { result } = stop({ message: `Done.\n${SIGN_OFF}` });
    assert.equal(result.status, 2, 'exit 2 is a Stop hook\'s block');
    assert.match(result.stderr, new RegExp(ARCHIVE));
  });

  test('reads the line as a person would write it: emphasis, a reason after it, trailing space', () => {
    for (const last of [`**${SIGN_OFF}**`, `_${SIGN_OFF}_`, `\`${SIGN_OFF}\``, `${SIGN_OFF}  `, 'Signing off: the pull request is merged.', 'Signing off!', 'Signing off']) {
      assert.equal(stop({ message: `Done.\n${last}` }).result.status, 2, last);
    }
  });

  // The reply to the request is the turn's newest reply, the one a dispatcher
  // reads. A session without the tool would read as not signed off unless
  // that reply ends with the line too.
  test('the request asks the reply to end with the sign-off line, whether the tool is there or not', () => {
    const { result } = stop({ message: SIGN_OFF });
    const [withTool, without] = result.stderr.split('If you do not have it');
    assert.ok(without !== undefined, result.stderr);
    assert.ok(withTool!.includes(SIGN_OFF), `after archiving: ${withTool}`);
    assert.ok(without.includes(SIGN_OFF), `without the tool: ${without}`);
  });

  // stop_hook_active says some Stop hook blocked; the turn it continued is
  // never blocked again, so the request is made once.
  test('a continued turn is never blocked again', () => {
    for (const message of ['That tool is not here.', `Archived.\n${SIGN_OFF}`]) {
      assert.equal(stop({ message, input: { stop_hook_active: true } }).result.status, 0, message);
    }
  });

  test('a turn that does not sign off is never blocked', () => {
    for (const message of ['Still going.', `${SIGN_OFF}\n\nOne more thing.`, 'Signing offline now.', 'I am signing off.', '', undefined, 7, [SIGN_OFF]]) {
      const { result } = stop({ message });
      assert.equal(result.status, 0, JSON.stringify(message));
      assert.equal(result.stderr, '', JSON.stringify(message));
    }
  });

  test('no event but Stop is blocked', () => {
    for (const event of ['UserPromptSubmit', 'SubagentStop', 'SessionStart', 'PreCompact', undefined]) {
      assert.equal(stop({ message: SIGN_OFF, input: { hook_event_name: event } }).result.status, 0, String(event));
    }
  });

  // A dispatcher archives a cloud session itself, and the desktop app's tool
  // is not there to call.
  test('a cloud session is never asked', () => {
    const { result } = stop({ message: SIGN_OFF, env: { CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE_ID } });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  test('it writes nothing for a dispatcher: no turn, signed off or not, makes a request', () => {
    for (const message of [`Done.\n\n${SIGN_OFF}`, 'Still going.']) {
      for (const env of [{}, { CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE_ID }]) {
        assert.deepEqual(stop({ message, env }).requests, [], `${JSON.stringify(message)} ${JSON.stringify(env)}`);
      }
    }
  });

  test('a payload that is not the hook\'s JSON never fails the turn', () => {
    for (const stdin of ['', 'not json', '[]', `"${SIGN_OFF}"`, 'null']) {
      const { result } = stop({ stdin });
      assert.equal(result.status, 0, JSON.stringify(stdin));
      assert.equal(result.stderr, '', JSON.stringify(stdin));
    }
  });

  test('with no python3 on the PATH it does nothing', () => {
    const bare = join(dir, 'bare');
    mkdirSync(bare, { recursive: true });
    const result = spawnSync('/bin/bash', [HOOK], {
      input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: SIGN_OFF }),
      encoding: 'utf-8',
      env: { PATH: bare, HOME: dir, CLAUDE_PROJECT_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });
});

// A repo that still carries the hook the plugin grew from registers it in its
// own settings. With both loaded, one stop would be blocked twice. The plugin
// stands down there, so it can be installed before that repo drops its copy.
describe('session-signoff: a project that carries its own copy of the hook', () => {
  test('is left to its own copy', () => {
    const project = mkdtempSync(join(tmpdir(), 'session-signoff-project-'));
    try {
      mkdirSync(join(project, '.claude/hooks'), { recursive: true });
      writeFileSync(join(project, '.claude/hooks/session-signoff.sh'), '#!/bin/bash\n');
      const own = stop({ message: SIGN_OFF, env: { CLAUDE_PROJECT_DIR: project } });
      assert.equal(own.result.status, 0);
      assert.equal(own.result.stderr, '');
      // Where the variable is unset, the session's working directory decides.
      const byCwd = stop({ message: SIGN_OFF, env: { CLAUDE_PROJECT_DIR: undefined }, input: { cwd: project } });
      assert.equal(byCwd.result.status, 0);
      rmSync(join(project, '.claude/hooks/session-signoff.sh'));
      assert.equal(stop({ message: SIGN_OFF, env: { CLAUDE_PROJECT_DIR: project } }).result.status, 2, 'with the copy gone, the plugin asks');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('session-signoff: registration', () => {
  const hooks = () => readJson(`${PLUGIN}/hooks/hooks.json`).hooks;
  const all = (event: string): any[] => (hooks()?.[event] ?? []).flatMap((g: any) => g.hooks ?? []);

  test('the marketplace lists it, and its manifest carries the same name and a version', () => {
    const entry = readJson('.claude-plugin/marketplace.json').plugins.find((p: any) => p.name === 'session-signoff');
    assert.ok(entry, 'session-signoff is listed');
    assert.equal(entry.source, `./${PLUGIN}`);
    const manifest = readJson(`${PLUGIN}/.claude-plugin/plugin.json`);
    assert.equal(manifest.name, 'session-signoff');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  });

  test('one Stop hook runs the script, blocking, and briefly', () => {
    const [hook, ...rest] = all('Stop');
    assert.equal(rest.length, 0, 'one Stop hook');
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, '"${CLAUDE_PLUGIN_ROOT}"/hooks/session-signoff.sh');
    assert.notEqual(hook.async, true, 'an async hook cannot block the stop it is meant to block');
    assert.ok(hook.timeout > 0 && hook.timeout <= 15, 'a blocking hook holds the turn open: keep it short');
  });

  test('no other event runs it', () => {
    assert.deepEqual(Object.keys(hooks()), ['Stop']);
  });

  test('the script it names exists and is executable', () => {
    assert.ok(existsSync(HOOK));
    assert.ok(statSync(HOOK).mode & 0o111, 'the hook command runs the script directly');
  });

  // A plugin cannot pre-approve a tool. Unless the machine's settings allow
  // the archive tool, the request stops on a permission prompt, so the README
  // has to say so, with the name the request uses.
  test('the README names the tool to allow, as the request names it', () => {
    const { result } = stop({ message: SIGN_OFF });
    const tools = result.stderr.match(/\bmcp__\w+/g) ?? [];
    assert.deepEqual(tools, [ARCHIVE], `the request names one tool: ${result.stderr}`);
    const readme = readFileSync(join(REPO_ROOT, PLUGIN, 'README.md'), 'utf-8');
    assert.ok(readme.includes(`"${ARCHIVE}"`), 'the README gives the permission entry to add');
  });
});
