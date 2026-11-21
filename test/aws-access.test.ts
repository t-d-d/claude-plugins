import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// aws-access: at session start its hook asks an access endpoint for the
// session's AWS profiles and writes them to ~/.aws/config. The endpoint is
// named by ACCESS_URL, and the environment's network secret adds the token,
// so the session holds no AWS key. Where the machine has no AWS CLI the hook
// installs it. Where ACCESS_URL is not set it does nothing at all.
//
// curl, unzip and aws are stand-ins on a PATH the test controls, and the CLI
// installs under a prefix in the fixture, so no test touches the network or
// the machine.
// ---------------------------------------------------------------------------

const PLUGIN = 'plugins/aws-access';
const HOOK = join(REPO_ROOT, PLUGIN, 'hooks/session-start.sh');
const readJson = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf-8'));

const CONFIG = '# access: profiles alpha alpha-operator\n[profile access-endpoint]\n';
const EARLIER = '# access: profiles earlier\n[profile earlier]\n';

type Fixture = { home: string; bin: string; prefix: string };

const script = (path: string, lines: string[]) => {
  writeFileSync(path, ['#!/bin/bash', ...lines].join('\n') + '\n');
  chmodSync(path, 0o755);
};

/** A home, a prefix for the CLI, and a bin of stand-ins. `withCli` puts an aws there already. */
const setup = ({ withCli = true } = {}): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'aws-access-'));
  const f = { home: join(root, 'home'), bin: join(root, 'bin'), prefix: join(root, 'prefix') };
  for (const d of [f.home, f.bin, f.prefix]) mkdirSync(d, { recursive: true });
  // curl records each URL it is asked for, and its arguments. A download
  // (-o) writes a file, or fails when FAIL_DOWNLOAD is set. Any other request
  // prints the config, or goes wrong the way CONFIG_GOES names:
  //   refused  curl -f on a 401
  //   empty    a 200 with no body
  //   cut      --max-time ran out part way through the body
  //   killed   the hook itself is ended part way through the body
  script(join(f.bin, 'curl'), [
    'url="${@: -1}"',
    'echo "$url" >> "$HOME/asked"',
    'echo "$*" >> "$HOME/argv"',
    'out=""',
    'while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done',
    'if [ -n "$out" ]; then',
    '  [ -z "${FAIL_DOWNLOAD:-}" ] || { echo "curl: (22) 403" >&2; exit 22; }',
    '  echo zip > "$out"; exit 0',
    'fi',
    'case "${CONFIG_GOES:-}" in',
    '  refused) echo "curl: (22) The requested URL returned error: 401" >&2; exit 22 ;;',
    '  empty) exit 0 ;;',
    '  cut) echo "# access: profiles al"; echo "curl: (28) Operation timed out" >&2; exit 28 ;;',
    '  killed) echo "# access: profiles al"; kill -TERM "$PPID"; exit 0 ;;',
    'esac',
    `printf '${CONFIG.replace(/\n/g, '\\n')}'`,
  ]);
  // unzip lays down the installer, which records its arguments and makes an aws.
  script(join(f.bin, 'unzip'), [
    'dest=""',
    'while [ $# -gt 0 ]; do [ "$1" = "-d" ] && dest="$2"; shift; done',
    'mkdir -p "$dest/aws"',
    `printf '%s\\n' '#!/bin/bash' 'echo "$@" > "$HOME/install-args"' 'while [ $# -gt 0 ]; do [ "$1" = "--bin-dir" ] && bin="$2"; shift; done' 'mkdir -p "$bin"; printf "#!/bin/bash\\n" > "$bin/aws"; chmod +x "$bin/aws"' > "$dest/aws/install"`,
    'chmod +x "$dest/aws/install"',
  ]);
  if (withCli) script(join(f.bin, 'aws'), ['exit 0']);
  return f;
};

const run = (f: Fixture, env: Record<string, string> = {}) => {
  const out = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf-8',
    // /usr/bin and /bin only: a CI runner keeps a real aws in /usr/local/bin.
    env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, AWS_ACCESS_PREFIX: f.prefix, ...env },
  });
  const asked = existsSync(join(f.home, 'asked')) ? readFileSync(join(f.home, 'asked'), 'utf-8').trim().split('\n') : [];
  const argv = existsSync(join(f.home, 'argv')) ? readFileSync(join(f.home, 'argv'), 'utf-8').trim().split('\n') : [];
  return { status: out.status, signal: out.signal, stdout: out.stdout, stderr: out.stderr, asked, argv };
};

/** A home that already holds a config, as a resumed session's does. */
const withEarlierConfig = (f: Fixture, text = EARLIER) => {
  mkdirSync(join(f.home, '.aws'), { recursive: true });
  writeFileSync(join(f.home, '.aws/config'), text);
};

/**
 * What a failed hook tells the session. Claude Code drops a failed hook's
 * plain stdout, and reads the context out of a JSON answer whatever the exit
 * code, so a failure is one JSON line. Checked on Claude Code 2.1.330.
 */
const failureContext = (stdout: string): string[] => {
  assert.equal(stdout.trim().split('\n').length, 1, `not one line: ${stdout}`);
  const answer = JSON.parse(stdout);
  assert.deepEqual(Object.keys(answer), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(answer.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(answer.hookSpecificOutput.hookEventName, 'SessionStart');
  return answer.hookSpecificOutput.additionalContext.split('\n');
};

const URL = { ACCESS_URL: 'https://endpoint.example/' };

describe('aws-access registration', () => {
  test('one blocking SessionStart hook runs the script, whenever the context is built or rebuilt', () => {
    const { hooks } = readJson(`${PLUGIN}/hooks/hooks.json`);
    assert.deepEqual(Object.keys(hooks), ['SessionStart']);
    assert.equal(hooks.SessionStart.length, 1);
    // A clear or a compaction rebuilds the context without the lines the
    // hook printed, so it runs then too and prints them again.
    assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
    const [hook, ...rest] = hooks.SessionStart[0].hooks;
    assert.equal(rest.length, 0);
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, '"${CLAUDE_PLUGIN_ROOT}"/hooks/session-start.sh');
    assert.notEqual(hook.async, true, 'the profiles must be in place before the first turn');
    assert.ok(hook.timeout <= 45, 'plugin-sources runs it inside its own 50 seconds');
    assert.ok(statSync(HOOK).mode & 0o111);
  });

  test('the marketplace lists it under its manifest name', () => {
    const names = readJson('.claude-plugin/marketplace.json').plugins.map((p: any) => p.name);
    assert.ok(names.includes('aws-access'));
    assert.equal(readJson(`${PLUGIN}/.claude-plugin/plugin.json`).name, 'aws-access');
  });
});

describe('aws-access where ACCESS_URL is not set', () => {
  test('does nothing: no request, no ~/.aws, and no CLI install', () => {
    const f = setup({ withCli: false });
    const r = run(f);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(r.asked, []);
    assert.ok(!existsSync(join(f.home, '.aws')));
    assert.ok(!existsSync(join(f.prefix, 'bin/aws')));
  });
});

describe("aws-access fetches the session's profiles", () => {
  test('writes ~/.aws/config from the endpoint and prints the profiles line', () => {
    const f = setup();
    const r = run(f, { ...URL, AWS_REGION: 'eu-west-2' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '# access: profiles alpha alpha-operator\n');
    assert.equal(readFileSync(join(f.home, '.aws/config'), 'utf-8'), CONFIG);
    assert.deepEqual(r.asked, ['https://endpoint.example/config?region=eu-west-2']);
  });

  test('asks for us-east-1 when the session names no region', () => {
    const f = setup();
    const r = run(f, { ACCESS_URL: 'https://endpoint.example' });
    assert.deepEqual(r.asked, ['https://endpoint.example/config?region=us-east-1']);
  });

  test('the fetch is bounded well under the time the hook is given', () => {
    const f = setup();
    const r = run(f, URL);
    const limit = /(?:^| )--max-time (\d+)(?: |$)/.exec(r.argv[0]);
    assert.ok(limit, `no --max-time in: ${r.argv[0]}`);
    const { timeout } = readJson(`${PLUGIN}/hooks/hooks.json`).hooks.SessionStart[0].hooks[0];
    assert.ok(Number(limit[1]) > 0 && Number(limit[1]) <= timeout / 3, `${limit[1]}s of the hook's ${timeout}s`);
  });
});

describe('aws-access says which profile is the default', () => {
  test('with AWS_PROFILE set, a second line names it', () => {
    const f = setup();
    const r = run(f, { ...URL, AWS_PROFILE: 'alpha-operator' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      '# access: profiles alpha alpha-operator\n# aws: default profile is alpha-operator; a bare aws call uses it\n',
    );
  });

  test('with AWS_PROFILE unset or empty, it prints the profiles line alone', () => {
    for (const env of [{}, { AWS_PROFILE: '' }]) {
      const r = run(setup(), { ...URL, ...env });
      assert.equal(r.stdout, '# access: profiles alpha alpha-operator\n');
    }
  });

  test('with no config, it names no default', () => {
    const r = run(setup(), { ...URL, AWS_PROFILE: 'alpha', CONFIG_GOES: 'refused' });
    assert.ok(!failureContext(r.stdout).some((line) => /default profile/.test(line)));
  });
});

describe('aws-access when the fetch fails', () => {
  test('a refused request fails the hook, keeps the config the session had, and leaves no part file', () => {
    const f = setup();
    withEarlierConfig(f);
    const r = run(f, { ...URL, CONFIG_GOES: 'refused' });
    assert.equal(r.status, 22, 'the hook fails with what curl exited');
    assert.equal(readFileSync(join(f.home, '.aws/config'), 'utf-8'), EARLIER);
    assert.ok(!existsSync(join(f.home, '.aws/config.part')));
  });

  test('an empty answer fails the hook and leaves the config as it was', () => {
    const f = setup();
    withEarlierConfig(f);
    const r = run(f, { ...URL, CONFIG_GOES: 'empty' });
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(join(f.home, '.aws/config'), 'utf-8'), EARLIER);
    assert.ok(!existsSync(join(f.home, '.aws/config.part')));
    assert.match(r.stderr, /aws-access: .*answered with nothing/);
  });

  test('an empty answer with no earlier config writes none', () => {
    const f = setup();
    const r = run(f, { ...URL, CONFIG_GOES: 'empty' });
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(join(f.home, '.aws/config')));
    assert.ok(!existsSync(join(f.home, '.aws/config.part')));
  });

  test('a fetch that runs out of time fails the hook, keeps the config, and leaves no part file', () => {
    const f = setup();
    withEarlierConfig(f);
    const r = run(f, { ...URL, CONFIG_GOES: 'cut' });
    assert.equal(r.status, 28);
    assert.equal(readFileSync(join(f.home, '.aws/config'), 'utf-8'), EARLIER);
    assert.ok(!existsSync(join(f.home, '.aws/config.part')));
  });

  test('a hook ended during the fetch leaves no part file', () => {
    const f = setup();
    withEarlierConfig(f);
    const r = run(f, { ...URL, CONFIG_GOES: 'killed' });
    assert.ok(r.status !== 0, 'the hook did not carry on');
    assert.equal(readFileSync(join(f.home, '.aws/config'), 'utf-8'), EARLIER);
    assert.ok(!existsSync(join(f.home, '.aws/config.part')));
  });

  test('says in the context that the fetch failed and the earlier config was kept, with its profiles and the default', () => {
    const f = setup();
    withEarlierConfig(f);
    const r = run(f, { ...URL, CONFIG_GOES: 'refused', AWS_PROFILE: 'earlier' });
    assert.deepEqual(failureContext(r.stdout), [
      '# aws: could not fetch the profiles (curl exit 22); kept the config fetched earlier',
      '# access: profiles earlier',
      '# aws: default profile is earlier; a bare aws call uses it',
    ]);
  });

  test('says in the context that the fetch failed and there was no earlier config to keep', () => {
    const r = run(setup(), { ...URL, CONFIG_GOES: 'cut' });
    assert.deepEqual(failureContext(r.stdout), [
      '# aws: could not fetch the profiles (curl exit 28); there is no earlier config, so no profile will work',
    ]);
  });

  test('an empty answer is said in the context too', () => {
    const f = setup();
    withEarlierConfig(f);
    const r = run(f, { ...URL, CONFIG_GOES: 'empty' });
    assert.deepEqual(failureContext(r.stdout), [
      '# aws: the access endpoint answered with nothing; kept the config fetched earlier',
      '# access: profiles earlier',
    ]);
  });

  test('the failure line stays valid JSON whatever the kept config and AWS_PROFILE hold', () => {
    const f = setup();
    withEarlierConfig(f, '# access: profiles "quoted" back\\slash\ttab\r\n[profile x]\n');
    const r = run(f, { ...URL, CONFIG_GOES: 'refused', AWS_PROFILE: 'a"b\\c' });
    assert.deepEqual(failureContext(r.stdout).slice(1), [
      '# access: profiles "quoted" back\\slash\ttab',
      '# aws: default profile is a"b\\c; a bare aws call uses it',
    ]);
  });
});

describe('aws-access installs the AWS CLI where the machine has none', () => {
  test("downloads the installer for this machine's architecture and installs under the prefix", () => {
    const f = setup({ withCli: false });
    const r = run(f, URL);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '# access: profiles alpha alpha-operator\n', 'the install prints nothing into the context');
    assert.equal(r.asked.length, 2);
    assert.match(r.asked[1], /^https:\/\/awscli\.amazonaws\.com\/awscli-exe-linux-(x86_64|aarch64)\.zip$/);
    assert.equal(
      readFileSync(join(f.home, 'install-args'), 'utf-8').trim(),
      `--install-dir ${f.prefix}/aws-cli --bin-dir ${f.prefix}/bin --update`,
    );
    assert.ok(existsSync(join(f.prefix, 'bin/aws')));
  });

  test('leaves a CLI that is already there alone', () => {
    const f = setup();
    const r = run(f, URL);
    assert.equal(r.asked.length, 1, 'only the config was asked for');
    assert.ok(!existsSync(join(f.home, 'install-args')));
  });

  test('a failed download is said on stderr, and the profiles are still written', () => {
    const f = setup({ withCli: false });
    const r = run(f, { ...URL, FAIL_DOWNLOAD: '1' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '# access: profiles alpha alpha-operator\n');
    assert.match(r.stderr, /AWS CLI/);
    assert.equal(readFileSync(join(f.home, '.aws/config'), 'utf-8'), CONFIG);
  });

  test('a refused config still fails the hook after a good install', () => {
    const f = setup({ withCli: false });
    const r = run(f, { ...URL, CONFIG_GOES: 'refused' });
    assert.notEqual(r.status, 0);
    assert.ok(existsSync(join(f.prefix, 'bin/aws')));
  });
});
