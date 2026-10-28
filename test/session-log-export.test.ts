import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../plugins/session-logs/hooks/session-log-export.sh');
const HOOK_PY = resolve(__dirname, '../plugins/session-logs/hooks/session-log-export.py');

// ---------------------------------------------------------------------------
// The plugin's Stop hook ships the session transcript to the session-logs
// drop box after every turn. It is mechanical (a hook, not an instruction), so the
// contract it has to keep is narrow and worth pinning:
//
//   - key = <drop url>/<session start date>/<session id>.jsonl.gz, where the
//     start date comes from the transcript's first timestamp, so the key is
//     stable across turns, midnight, and a resume days later;
//   - the body is the whole transcript, gzipped, with secrets redacted;
//   - the writer secret rides the Referer header (what the bucket policy
//     gates on), and the branch and the repo ride object metadata;
//   - the commit in that metadata is HEAD as it was when the session STARTED,
//     seeded by the hook's `--seed-commit` half from SessionStart and only
//     read back at Stop;
//   - no drop URL, no secret, or no transcript → silent no-op, exit 0.
//
// curl is stubbed through SESSION_LOG_CURL so the test never touches
// the network; the stub records its argv and copies the uploaded body.
// ---------------------------------------------------------------------------

const SESSION = '7ca285bb-1bef-54b9-9968-fb7472cb526c';
const DROP_URL = 'https://session-logs-123456789012.s3.eu-west-1.amazonaws.com/drop/tom-mac';
const SECRET = 'writer-secret-0123456789';

const TRANSCRIPT_LINES = [
  JSON.stringify({ type: 'queue-operation', sessionId: SESSION, timestamp: '2026-09-03T23:58:12.000Z' }),
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    gitBranch: 'claude/session-logs-s3-export-ablas6',
    timestamp: '2026-09-03T23:58:13.000Z',
    message: { role: 'user', content: 'gh-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789\nPlease fix #12' },
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    gitBranch: 'claude/session-logs-s3-export-ablas6',
    timestamp: '2026-09-04T00:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'export GH_TOKEN=ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210 # x' }] },
  }),
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    timestamp: '2026-09-04T00:02:00.000Z',
    message: { role: 'user', content: 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and AKIAIOSFODNN7EXAMPLE' },
  }),
  // Tool output is where secrets most often land, and there they are usually
  // quoted (a shell export, a JSON config dump) or are the hook's own writer
  // secret from an env dump.
  JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    timestamp: '2026-09-04T00:03:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't9',
          content: [
            'export AWS_SECRET_ACCESS_KEY="QUOTEDshellSecretQUOTEDshellSecret1234"',
            '{"aws_secret_access_key": "JSONformSecretJSONformSecretJSON5678"}',
            `SESSION_LOG_SECRET=${SECRET}`,
            'ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz_0123-456789',
          ].join('\n'),
        },
      ],
    },
  }),
];

let dir: string;
let transcript: string;
let stub: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'session-log-export-'));
  transcript = join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, TRANSCRIPT_LINES.join('\n') + '\n');
  stub = join(dir, 'curl-stub.sh');
  writeFileSync(
    stub,
    [
      '#!/bin/bash',
      'printf "%s\\n" "$@" > "$STUB_ARGS"',
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = "-T" ] || [ "$1" = "--upload-file" ]; then cp "$2" "$STUB_BODY"; fi',
      '  shift',
      'done',
      'exit 0',
    ].join('\n') + '\n',
  );
  chmodSync(stub, 0o755);
});

after(() => rmSync(dir, { recursive: true, force: true }));

type RunOpts = {
  env?: Record<string, string | undefined>;
  stdin?: string;
  cwd?: string;
  sessionId?: string;
};

function hookEnv(env: Record<string, string | undefined> = {}) {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    // The hook caches the session's starting commit next to its lock, both
    // under the temp dir. Pinning TMPDIR here keeps that cache inside the
    // fixture, so one test's session cannot leak into another's run.
    TMPDIR: dir,
    SESSION_LOG_URL: DROP_URL,
    SESSION_LOG_SECRET: SECRET,
    SESSION_LOG_CURL: stub,
    STUB_ARGS: join(dir, 'args.txt'),
    STUB_BODY: join(dir, 'body.gz'),
    ...env,
  };
}

function runHook({ env = {}, stdin, cwd = dir, sessionId = SESSION }: RunOpts = {}) {
  const args = join(dir, 'args.txt');
  const body = join(dir, 'body.gz');
  rmSync(args, { force: true });
  rmSync(body, { force: true });
  const result = spawnSync('bash', [HOOK], {
    input: stdin ?? JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd }),
    encoding: 'utf-8',
    env: hookEnv(env),
  });
  const argv = existsSync(args) ? readFileSync(args, 'utf-8').split('\n').filter(Boolean) : null;
  return { result, argv, body: existsSync(body) ? readFileSync(body) : null };
}

type SeedOpts = { cwd?: string; sessionId?: string; source?: string; env?: Record<string, string | undefined> };

/** The SessionStart half: record HEAD before the first turn can move it. */
function seedCommit({ cwd = dir, sessionId = SESSION, source = 'startup', env = {} }: SeedOpts = {}) {
  return spawnSync('bash', [HOOK, '--seed-commit'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, cwd, source }),
    encoding: 'utf-8',
    env: hookEnv(env),
  });
}

/** Where the seed leaves the starting commit, given TMPDIR is pinned to the fixture. */
const commitCache = (sessionId: string) =>
  join(dir, `session-log-head-${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);

const metaHeader = (name: string) => (argv: string[] | null) =>
  argv?.filter((_, i) => argv[i - 1] === '-H').find((h) => h.startsWith(`x-amz-meta-${name}:`)) ?? null;
const commitHeader = metaHeader('commit');
const repoHeader = metaHeader('repo');

/** A throwaway git repo whose only file is CLAUDE.md; `commit` returns the new sha. */
function makeRepo(label: string) {
  const repo = mkdtempSync(join(tmpdir(), `session-log-export-${label}-`));
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env: { ...process.env, HOME: repo } });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  const commit = (text: string) => {
    writeFileSync(join(repo, 'CLAUDE.md'), `${text}\n`);
    git('add', '-A');
    git('commit', '-qm', text);
    return git('rev-parse', 'HEAD').stdout.trim();
  };
  return { repo, commit };
}

describe('plugins/session-logs/hooks/session-log-export.sh', () => {
  test('uploads the gzipped transcript to <url>/<start date>/<session>.jsonl.gz', () => {
    const { result, argv, body } = runHook();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(argv, 'curl must be invoked');
    // Start date is the first timestamp's UTC date, not the last turn's.
    assert.ok(argv.includes(`${DROP_URL}/2026-09-03/${SESSION}.jsonl.gz`), argv.join(' '));
    assert.ok(body, 'curl must be given a body to upload');
    const lines = gunzipSync(body).toString('utf-8').trimEnd().split('\n');
    assert.equal(lines.length, TRANSCRIPT_LINES.length, 'every line survives');
    for (const line of lines) JSON.parse(line); // still valid JSONL after redaction
  });

  test('the writer secret rides the Referer header; branch rides metadata', () => {
    const { argv } = runHook();
    const headers = argv!.filter((_, i) => argv![i - 1] === '-H');
    assert.ok(headers.some((h) => h === `Referer: ${SECRET}`), headers.join(' | '));
    assert.ok(
      headers.some((h) => h === 'x-amz-meta-branch: claude/session-logs-s3-export-ablas6'),
      headers.join(' | '),
    );
    assert.ok(headers.some((h) => /^Content-Type: application\/gzip$/i.test(h)), headers.join(' | '));
    assert.ok(argv!.includes('-T'), 'curl must PUT with --upload-file');
  });

  test("the starting commit rides metadata, even when the session commits in its first turn", () => {
    // Which revision of CLAUDE.md and the skills the session actually read is
    // the treatment variable for any before-and-after comparison, and the
    // transcript carries no commit anywhere. Stop fires *after* a turn, so a
    // HEAD resolved there is whatever the session has committed by then — for
    // a session that commits, a commit it wrote itself, which inverts the
    // field's purpose. Only a hook running before turn 1 can see the revision
    // the session actually read, so the seed is where the value is decided and
    // Stop only reads it back.
    const { repo, commit } = makeRepo('repo');
    const sessionId = 'commit-fixture-session';
    try {
      const startSha = commit('first');

      seedCommit({ cwd: repo, sessionId }); // SessionStart, before turn 1

      // The session commits during its first turn, as many do.
      assert.notEqual(commit('second'), startSha, 'HEAD must have moved');

      const first = runHook({ cwd: repo, sessionId });
      assert.equal(
        commitHeader(first.argv),
        `x-amz-meta-commit: ${startSha}`,
        'the first Stop must report the commit the session started on',
      );

      commit('third');
      const later = runHook({ cwd: repo, sessionId });
      assert.equal(
        commitHeader(later.argv),
        `x-amz-meta-commit: ${startSha}`,
        'a later turn must still report the starting commit',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a resume, clear or compaction never re-seeds a later HEAD', () => {
    // SessionStart fires on all four, and the last three land after HEAD may
    // have moved. Re-seeding on one would reintroduce the same bug on every
    // resumed session.
    const { repo, commit } = makeRepo('resume');
    const sessionId = 'resume-fixture-session';
    try {
      const startSha = commit('first');
      seedCommit({ cwd: repo, sessionId });
      commit('second');

      for (const source of ['resume', 'clear', 'compact']) {
        const seeded = seedCommit({ cwd: repo, sessionId, source });
        assert.equal(seeded.status, 0, `${source}: ${seeded.stderr}`);
      }

      const { argv } = runHook({ cwd: repo, sessionId });
      assert.equal(commitHeader(argv), `x-amz-meta-commit: ${startSha}`, argv!.join(' '));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a swept cache costs the commit header rather than reporting a later HEAD', () => {
    // The cache is a temp-dir file with no invalidation, so a sweep can take it
    // mid-session. Stop must not fall back to resolving HEAD: by then HEAD is
    // whatever the session has committed, which is exactly the wrong answer.
    const { repo, commit } = makeRepo('swept');
    const sessionId = 'swept-cache-session';
    try {
      commit('first');
      seedCommit({ cwd: repo, sessionId });
      commit('second');
      rmSync(commitCache(sessionId), { force: true });

      const { argv, result } = runHook({ cwd: repo, sessionId });
      assert.equal(result.status, 0);
      assert.equal(commitHeader(argv), null, 'no header beats a wrong one');
      assert.ok(argv!.includes('-T'), 'the transcript still ships');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('two sessions never share one cached commit', () => {
    // The cache is keyed on the session id, so the sanitiser that makes that
    // id a filename must not collapse two ids into one name: the second
    // session would report the first's HEAD, from a repo it never saw.
    const repos = ['commit-cache-a', 'commit-cache-b'].map((label) => {
      const { repo, commit } = makeRepo(label);
      return { repo, sha: commit(label) };
    });
    try {
      assert.notEqual(repos[0]!.sha, repos[1]!.sha, 'the two repos must differ');
      // Two ids that differ only in a character a filename cannot hold.
      const ids = ['cache+collision', 'cachecollision'];
      const reported = ids.map((sessionId, i) => {
        seedCommit({ cwd: repos[i]!.repo, sessionId });
        return commitHeader(runHook({ cwd: repos[i]!.repo, sessionId }).argv);
      });
      assert.equal(reported[0], `x-amz-meta-commit: ${repos[0]!.sha}`, reported.join(' | '));
      assert.equal(reported[1], `x-amz-meta-commit: ${repos[1]!.sha}`, reported.join(' | '));
    } finally {
      for (const { repo } of repos) rmSync(repo, { recursive: true, force: true });
    }
  });

  test('an unreadable commit cache costs the commit header, never the upload', () => {
    // The cache is a best-effort lookup in a shared temp dir. A file there
    // that is not decodable text must degrade to "no commit", not take the
    // transcript down with it — silently, on every remaining turn, because
    // the bad file stays put.
    const sessionId = 'bad-cache-session';
    writeFileSync(join(dir, `session-log-head-${sessionId}.txt`), Buffer.from([0xff, 0xfe, 0xff]));
    const { argv, result } = runHook({ sessionId });
    assert.equal(result.status, 0);
    assert.ok(argv, 'the transcript must still ship');
    assert.ok(argv.includes('-T'), argv.join(' '));
  });

  test('no git repository → upload proceeds without a commit header', () => {
    // The fixture dir is not a repo, so the seed has nothing to record and
    // Stop has nothing to read back.
    const sessionId = 'no-repo-session';
    const seeded = seedCommit({ sessionId });
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.equal(existsSync(commitCache(sessionId)), false, 'nothing to cache outside a repo');

    const { argv, result } = runHook({ sessionId });
    assert.equal(commitHeader(argv), null, argv!.join(' '));
    assert.ok(argv!.includes('-T'), 'the transcript still ships');
    assert.equal(result.status, 0);
  });

  test('no drop URL → the seed is a silent no-op too', () => {
    // Where the drop box is unconfigured there is nothing to upload, so the
    // SessionStart half must leave no trace either.
    const { repo, commit } = makeRepo('unconfigured');
    const sessionId = 'unconfigured-seed-session';
    try {
      commit('first');
      const seeded = seedCommit({ cwd: repo, sessionId, env: { SESSION_LOG_URL: undefined } });
      assert.equal(seeded.status, 0);
      assert.equal(seeded.stdout, '');
      assert.equal(existsSync(commitCache(sessionId)), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('secrets are redacted before upload', () => {
    const { body } = runHook();
    const text = gunzipSync(body!).toString('utf-8');
    assert.ok(!text.includes('ghs_abcdefghijklmnopqrstuvwxyz0123456789'), 'GitHub App token');
    assert.ok(!text.includes('ghp_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210'), 'GitHub PAT');
    assert.ok(!text.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), 'AWS secret key');
    assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS access key id');
    assert.ok(!text.includes('QUOTEDshellSecretQUOTEDshellSecret1234'), 'quoted shell export');
    assert.ok(!text.includes('JSONformSecretJSONformSecretJSON5678'), 'JSON-form key');
    assert.ok(!text.includes(SECRET), 'the writer secret the hook itself holds');
    assert.ok(!text.includes('AbCdEfGhIjKlMnOpQrStUvWxYz_0123-456789'), 'Anthropic API key');
    assert.ok(text.includes('ANTHROPIC_API_KEY='), 'the variable name survives');
    // Non-secret content is untouched, including the surrounding prompt.
    assert.ok(text.includes('Please fix #12'));
    assert.ok(text.includes('gh-token:'), 'the marker survives so the shape of the prompt is legible');
  });

  test('no drop URL → silent no-op', () => {
    const { result, argv } = runHook({ env: { SESSION_LOG_URL: undefined } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(argv, null);
  });

  test('no secret → silent no-op', () => {
    const { result, argv } = runHook({ env: { SESSION_LOG_SECRET: undefined } });
    assert.equal(result.status, 0);
    assert.equal(argv, null);
  });

  test('missing transcript → silent no-op', () => {
    const { result, argv } = runHook({
      stdin: JSON.stringify({ session_id: SESSION, transcript_path: join(dir, 'nope.jsonl') }),
    });
    assert.equal(result.status, 0);
    assert.equal(argv, null);
  });

  test('a curl failure never fails the hook', () => {
    const failing = join(dir, 'curl-fail.sh');
    writeFileSync(failing, '#!/bin/bash\necho "curl: (22) 403" >&2\nexit 22\n');
    chmodSync(failing, 0o755);
    const { result } = runHook({ env: { SESSION_LOG_CURL: failing } });
    assert.equal(result.status, 0, 'hook exit code must stay 0');
  });

  // The .py carries its own "every error path returns 0 and says nothing"
  // contract (its docstring), independent of the .sh wrapper that guards the
  // env vars before calling it. Pin the module directly: a missing var must be
  // a silent exit 0, not an uncaught KeyError traceback, even with a transcript
  // present so the run reaches the env read.
  test('the python module exits 0 when a required env var is missing', () => {
    const result = spawnSync('python3', [HOOK_PY], {
      input: JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: dir }),
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        // URL present, secret absent: the run reaches the env read but must
        // still no-op silently rather than throwing.
        SESSION_LOG_URL: DROP_URL,
        SESSION_LOG_CURL: stub,
        STUB_ARGS: join(dir, 'py-args.txt'),
        STUB_BODY: join(dir, 'py-body.gz'),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'no traceback on the missing-var path');
    assert.equal(existsSync(join(dir, 'py-args.txt')), false, 'curl must not run without a secret');
  });

  test('a malformed session id is a silent no-op, not a traceback', () => {
    // Same contract, on the seed path: the payload is someone else's JSON, so
    // a field of the wrong type must cost the header rather than raise. The
    // cwd is a real repo so the no-op cannot be explained away by there being
    // no HEAD to record: the id guard is what has to hold.
    const { repo, commit } = makeRepo('malformed');
    try {
      commit('first');
      const result = spawnSync('python3', [HOOK_PY, '--seed-commit'], {
        input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 7, cwd: repo }),
        encoding: 'utf-8',
        env: hookEnv(),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '', 'no traceback on the malformed-payload path');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('the Stop half survives `set -u` with no arguments', () => {
    // The wrapper forwards its argv so SessionStart can pass --seed-commit.
    // But bash before 4.4 — /bin/bash on every Mac — treats "$@" as unset under
    // `set -u` when there are no positional parameters, and aborts the script.
    // Stop passes none, so a bare forward would silently stop every upload
    // from a developer's machine. No shell on a CI box reproduces that, so pin
    // the shape instead: every forward guarded, so it expands to nothing.
    const wrapper = readFileSync(HOOK, 'utf-8');
    assert.match(wrapper, /^set -u$/m, 'the guard only matters while `set -u` is on');
    // Comment lines out first: they talk about the very shape being pinned.
    const code = wrapper.replace(/^\s*#.*$/gm, '');
    const forwards = code.match(/\$\{1\+"\$@"\}|"\$@"/g) ?? [];
    assert.ok(forwards.length > 0, 'the wrapper must forward its argv to the python module');
    assert.deepEqual(
      forwards.filter((f) => f === '"$@"'),
      [],
      'forward as ${1+"$@"}: a bare "$@" aborts the whole script on bash 3.2',
    );
  });

  describe('the repo rides metadata, read from the origin remote of the payload cwd', () => {
    // Several repos share one writer once the plugin is installed per machine
    // or per environment, so the drop's key no longer says which repo a
    // session ran in. The retro reads it from x-amz-meta-repo.
    const withOrigin = (origin: string | null) => {
      const { repo, commit } = makeRepo('origin');
      commit('first');
      if (origin !== null) spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
      try {
        return runHook({ cwd: repo, sessionId: 'repo-header-session' });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    };

    for (const origin of [
      'https://github.com/octo/widgets.git',
      'https://github.com/octo/widgets',
      'https://github.com/octo/widgets/',
      'https://x-access-token:abc123@github.com/octo/widgets.git',
      'git@github.com:octo/widgets.git',
      'ssh://git@github.com/octo/widgets.git',
      'ssh://git@github.com:22/octo/widgets',
      // A cloud session's checkout reaches GitHub through a local git proxy.
      'http://local_proxy@127.0.0.1:41245/git/octo/widgets',
    ]) {
      test(origin, () => {
        const { argv, result } = withOrigin(origin);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(repoHeader(argv), 'x-amz-meta-repo: octo/widgets', argv!.join(' '));
      });
    }

    test('a checkout with no origin ships without the header', () => {
      const { argv } = withOrigin(null);
      assert.ok(argv!.includes('-T'), 'the transcript still ships');
      assert.equal(repoHeader(argv), null, argv!.join(' '));
    });

    test('outside a repository the transcript ships without the header', () => {
      const { argv } = runHook({ sessionId: 'no-repo-header-session' });
      assert.ok(argv!.includes('-T'));
      assert.equal(repoHeader(argv), null, argv!.join(' '));
    });

    test('an origin that is not owner/name ships without the header', () => {
      for (const origin of ['https://example.com/widgets.git', '/srv/git/widgets', 'https://github.com/octo/wid gets']) {
        const { argv } = withOrigin(origin);
        assert.equal(repoHeader(argv), null, `${origin}: ${argv!.join(' ')}`);
      }
    });
  });
});
