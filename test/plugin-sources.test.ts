import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// plugin-sources: at session start its hook reads the repo's
// .claude/plugin-sources.json, clones each public plugin it lists at a pinned
// commit or tag, and copies the plugin into a skills folder, where Claude Code
// adopts it as a <name>@skills-dir plugin. In a cloud session the folder is
// ~/.claude/skills; locally it is the repo's own .claude/skills, with a
// .gitignore inside each copy. The hook prints nothing and always exits 0.
//
//
// A cloud environment can have a list of its own, ~/.claude/plugin-sources.json,
// which its setup script writes. It may name plugins, and it may name one list
// to follow on a branch of a public repo, so one commit there reaches every
// environment. A repo's list is read first.
//
// A plugin copied in after the session started misses its own SessionStart
// hooks, so in a cloud session the hook runs them itself.
//
// Sources here are local git repos under a fake base URL
// (PLUGIN_SOURCES_GIT_BASE), so no test touches the network.
// ---------------------------------------------------------------------------

const PLUGIN = 'plugins/plugin-sources';
const HOOK = join(REPO_ROOT, PLUGIN, 'hooks/plugin-sources.sh');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8'));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

/** A source repo at <base>/<owner>/<name> holding one plugin per entry of `plugins` (folder → manifest name). */
const makeSource = (base: string, repo: string, plugins: Record<string, string>, tag?: string) => {
  const dir = join(base, repo);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [folder, name] of Object.entries(plugins)) {
    mkdirSync(join(dir, folder, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, folder, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
    mkdirSync(join(dir, folder, 'skills', `${name}-check`), { recursive: true });
    writeFileSync(join(dir, folder, 'skills', `${name}-check`, 'SKILL.md'), `---\nname: ${name}-check\ndescription: test\n---\n`);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'plugins');
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  if (tag) git(dir, 'tag', tag);
  return git(dir, 'rev-parse', 'HEAD');
};

/** Commit more files to a source repo (path → content; a .sh file is made executable). Returns the new commit. */
const commitFiles = (base: string, repo: string, files: Record<string, string>, tag?: string) => {
  const dir = join(base, repo);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
    if (path.endsWith('.sh')) chmodSync(join(dir, path), 0o755);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'files');
  if (tag) git(dir, 'tag', tag);
  return git(dir, 'rev-parse', 'HEAD');
};

type Run = { project: string; home: string; tmp: string; base: string; remote?: boolean; session?: string; source?: string };

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-sources-'));
  const s: Run = {
    project: join(root, 'project'),
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    base: join(root, 'github'),
  };
  for (const d of [s.project, s.home, s.tmp, s.base]) mkdirSync(d, { recursive: true });
  return s;
};

const writeList = (project: string, plugins: unknown) => {
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude/plugin-sources.json'), typeof plugins === 'string' ? plugins : JSON.stringify({ plugins }));
};

const run = (s: Run, session = s.session ?? 'session-1') => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: s.home,
    TMPDIR: s.tmp,
    CLAUDE_PROJECT_DIR: s.project,
    PLUGIN_SOURCES_GIT_BASE: `file://${s.base}`,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (s.remote) env.CLAUDE_CODE_REMOTE = 'true';
  const input = { session_id: session, cwd: s.project, hook_event_name: 'SessionStart', source: s.source ?? 'startup' };
  const out = spawnSync(HOOK, { input: JSON.stringify(input), env, encoding: 'utf-8' });
  const reportPath = join(s.tmp, 'plugin-sources/report.json');
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, report: existsSync(reportPath) ? readJson(reportPath) : undefined };
};

/** The one notice a local run may print: a hook's JSON with a systemMessage, which Claude Code shows the person. */
const notice = (stdout: string): string => {
  const parsed = JSON.parse(stdout);
  assert.deepEqual(Object.keys(parsed), ['systemMessage'], 'nothing but the notice');
  assert.match(parsed.systemMessage, /\/reload-plugins/);
  return parsed.systemMessage;
};

/** The environment's own list, which a setup script writes. */
const writeHomeList = (s: Run, content: unknown) => {
  mkdirSync(join(s.home, '.claude'), { recursive: true });
  writeFileSync(join(s.home, '.claude/plugin-sources.json'), typeof content === 'string' ? content : JSON.stringify(content));
};

/**
 * A source plugin "greeter" at acme/hooked whose SessionStart hooks are `hooks`.
 * Its start.sh saves the hook input under $HOME, counts its runs, and prints a line.
 */
const makeHooked = (s: Run, hooks: unknown[], tag = 'v1') =>
  commitFiles(
    s.base,
    'acme/hooked',
    {
      'plugins/greeter/.claude-plugin/plugin.json': JSON.stringify({ name: 'greeter', version: '1.0.0' }),
      'plugins/greeter/hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: hooks } }),
      'plugins/greeter/hooks/start.sh': [
        '#!/bin/bash',
        'cat > "$HOME/greeter-input.json"',
        'echo run >> "$HOME/greeter-runs"',
        'echo "$CLAUDE_PLUGIN_ROOT" > "$HOME/greeter-root"',
        'echo "greeter: profiles a b"',
      ].join('\n') + '\n',
    },
    tag,
  );
const START = { type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}"/hooks/start.sh', timeout: 10 };
const greeterRuns = (s: Run) =>
  existsSync(join(s.home, 'greeter-runs')) ? readFileSync(join(s.home, 'greeter-runs'), 'utf-8').trim().split('\n').length : 0;
const hookStates = (report: any) => (report.hooks ?? []).map((h: any) => `${h.plugin}: ${h.state}`);

const userSkills = (s: Run) => join(s.home, '.claude/skills');
const projectSkills = (s: Run) => join(s.project, '.claude/skills');
const reasons = (report: any) => report.skipped.map((k: any) => k.reason).join('\n');

describe('plugin-sources registration', () => {
  test('one blocking SessionStart hook runs the script, with room for several clones', () => {
    const { hooks } = readJson(join(REPO_ROOT, PLUGIN, 'hooks/hooks.json'));
    assert.deepEqual(Object.keys(hooks), ['SessionStart']);
    const all = hooks.SessionStart.flatMap((g: any) => g.hooks ?? []);
    assert.equal(all.length, 1);
    assert.equal(all[0].command, '"${CLAUDE_PLUGIN_ROOT}"/hooks/plugin-sources.sh');
    assert.notEqual(all[0].async, true, 'plugins must be in place before the first turn');
    assert.equal(all[0].timeout, 60);
    assert.ok(statSync(HOOK).mode & 0o111);
  });

  test('the marketplace lists it', () => {
    const names = readJson(join(REPO_ROOT, '.claude-plugin/marketplace.json')).plugins.map((p: any) => p.name);
    assert.ok(names.includes('plugin-sources'));
  });
});

describe('plugin-sources in a cloud session', () => {
  test('delivers a plugin pinned to a tag into ~/.claude/skills, and prints nothing', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    const r = run(s);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(readJson(join(userSkills(s), 'lint/.claude-plugin/plugin.json')).name, 'lint');
    assert.ok(existsSync(join(userSkills(s), 'lint/skills/lint-check/SKILL.md')));
    assert.ok(!existsSync(join(userSkills(s), 'lint/.gitignore')), 'no .gitignore outside a repo');
    assert.ok(!existsSync(join(userSkills(s), 'lint/.git')));
    assert.ok(!existsSync(projectSkills(s)), 'the repo is left alone in the cloud');
    assert.deepEqual(r.report.delivered.map((d: any) => d.name), ['lint']);
  });

  test('accepts a full commit hash as the ref', () => {
    const s = { ...setup(), remote: true };
    const sha = makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' });
    writeList(s.project, [{ repo: 'acme/tools', ref: sha, path: 'plugins/lint' }]);
    run(s);
    assert.ok(existsSync(join(userSkills(s), 'lint/.claude-plugin/plugin.json')));
  });

  test('reads the list in each repo below the start folder when the start folder has none', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint', 'plugins/fmt': 'fmt' }, 'v1');
    writeList(join(s.project, 'repo-a'), [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    writeList(join(s.project, 'repo-b'), [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/fmt' }]);
    run(s);
    assert.deepEqual(readdirSync(userSkills(s)).sort(), ['fmt', 'lint']);
  });
});

describe('plugin-sources in a local session', () => {
  test("delivers into the repo's own .claude/skills, which git then ignores", () => {
    const s = setup();
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    git(s.project, 'init', '-q');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    git(s.project, 'add', '-A');
    git(s.project, 'commit', '-q', '-m', 'list');
    const r = run(s);
    assert.match(notice(r.stdout), /lint/);
    assert.equal(readJson(join(projectSkills(s), 'lint/.claude-plugin/plugin.json')).name, 'lint');
    assert.equal(readFileSync(join(projectSkills(s), 'lint/.gitignore'), 'utf-8'), '*\n');
    assert.equal(git(s.project, 'status', '--porcelain'), '', 'git sees nothing new');
    assert.ok(!existsSync(userSkills(s)), 'a local run never writes to ~/.claude/skills');
  });
});

describe('plugin-sources tells a local session when it must reload, and stays quiet otherwise', () => {
  // A local session scans the repo's .claude/skills before the hook runs, so
  // a plugin the hook adds, updates or removes takes effect after
  // /reload-plugins. A cloud session picks plugins up in the same session.
  const tools = (s: Run, tags: string[]) => {
    const dir = join(s.base, 'acme/tools');
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint', 'plugins/fmt': 'fmt' }, tags[0]);
    for (const tag of tags.slice(1)) {
      writeFileSync(join(dir, 'plugins/lint/README.md'), tag);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', tag);
      git(dir, 'tag', tag);
    }
  };

  test('a later local session with nothing changed copies nothing and prints nothing', () => {
    const s = setup();
    tools(s, ['v1']);
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    run(s, 'first');
    const r = run(s, 'second');
    assert.equal(r.stdout, '');
    assert.deepEqual(r.report.delivered, []);
    assert.deepEqual(r.report.unchanged, ['lint']);
  });

  test('a local session that moves a plugin to a new ref names it in the notice', () => {
    const s = setup();
    tools(s, ['v1', 'v2']);
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    run(s, 'first');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v2', path: 'plugins/lint' }]);
    const r = run(s, 'second');
    assert.match(notice(r.stdout), /lint/);
    assert.equal(readFileSync(join(projectSkills(s), 'lint/README.md'), 'utf-8'), 'v2');
  });

  test('a local session that removes a plugin names it in the notice', () => {
    const s = setup();
    tools(s, ['v1']);
    writeList(s.project, [
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' },
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/fmt' },
    ]);
    run(s, 'first');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    const r = run(s, 'second');
    assert.match(notice(r.stdout), /fmt/);
  });

  test('a cloud session never prints a notice, and does not copy an unchanged plugin again', () => {
    const s = { ...setup(), remote: true };
    tools(s, ['v1']);
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    assert.equal(run(s, 'first').stdout, '');
    const r = run(s, 'second');
    assert.equal(r.stdout, '');
    assert.deepEqual(r.report.unchanged, ['lint']);
  });
});

describe('plugin-sources skips what it cannot use, and the session still starts', () => {
  test('a branch name, a missing tag, an unreachable repo and malformed entries are each skipped with a reason', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    writeList(s.project, [
      { repo: 'acme/tools', ref: 'main', path: 'plugins/lint' },
      { repo: 'acme/tools', ref: 'v9', path: 'plugins/lint' },
      { repo: 'acme/missing', ref: 'v1', path: 'plugins/lint' },
      { repo: 'not a repo', ref: 'v1', path: 'plugins/lint' },
      { repo: 'acme/tools', ref: 'v1', path: '../escape' },
      { repo: 'acme/tools', ref: 'v1' },
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/none' },
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' },
    ]);
    const r = run(s);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.report.skipped.length, 7);
    const why = reasons(r.report);
    assert.match(why, /no tag "main"/);
    assert.match(why, /a branch name is not accepted/);
    assert.match(why, /no tag "v9"/);
    assert.match(why, /cannot fetch acme\/missing/);
    assert.match(why, /repo must be owner\/name/);
    assert.match(why, /path must stay inside the repo/);
    assert.match(why, /path is missing/);
    assert.match(why, /no plugin manifest at plugins\/none/);
    assert.deepEqual(readdirSync(userSkills(s)), ['lint'], 'the good entry still lands');
  });

  test('a list that is not valid JSON is logged, and nothing is printed', () => {
    const s = { ...setup(), remote: true };
    writeList(s.project, '{ not json');
    const r = run(s);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.report.errors.join('\n'), /plugin-sources\.json/);
  });

  test('sources it could not fetch are kept as leftovers for a later broker', () => {
    const s = { ...setup(), remote: true };
    writeList(s.project, [{ repo: 'acme/private', ref: 'v1', path: 'plugins/secret' }]);
    const r = run(s);
    assert.deepEqual(r.report.unreached, [{ repo: 'acme/private', ref: 'v1', path: 'plugins/secret' }]);
  });
});

describe('plugin-sources keeps its own folders tidy and leaves others alone', () => {
  test('a second run in the same session does nothing', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    run(s, 'same');
    rmSync(join(userSkills(s), 'lint'), { recursive: true });
    const r = run(s, 'same');
    assert.equal(r.report.already_ran, true);
    assert.ok(!existsSync(join(userSkills(s), 'lint')));
  });

  test('a plugin dropped from the list is removed next time, and a folder it did not make is never touched', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint', 'plugins/fmt': 'fmt' }, 'v1');
    mkdirSync(join(userSkills(s), 'mine'), { recursive: true });
    writeFileSync(join(userSkills(s), 'mine/SKILL.md'), 'mine');
    writeList(s.project, [
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' },
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/fmt' },
    ]);
    run(s, 'first');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    const r = run(s, 'second');
    assert.deepEqual(readdirSync(userSkills(s)).sort(), ['lint', 'mine']);
    assert.deepEqual(r.report.removed, ['fmt']);
    assert.equal(readFileSync(join(userSkills(s), 'mine/SKILL.md'), 'utf-8'), 'mine');
  });

  test('in a cloud session, deleting the list removes what earlier runs delivered', () => {
    // A cloud container can be reused, so a session on a repo with no list
    // must not inherit plugins an earlier session fetched.
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    run(s, 'first');
    rmSync(join(s.project, '.claude/plugin-sources.json'));
    const r = run(s, 'second');
    assert.deepEqual(r.report.removed, ['lint']);
    assert.deepEqual(readdirSync(userSkills(s)), []);
  });

  test("locally, deleting the list removes what earlier runs put in the repo's .claude/skills", () => {
    const s = setup();
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    run(s, 'first');
    rmSync(join(s.project, '.claude/plugin-sources.json'));
    const r = run(s, 'second');
    assert.deepEqual(r.report.removed, ['lint']);
    assert.deepEqual(readdirSync(projectSkills(s)), []);
  });

  test('a listed plugin whose fetch fails keeps its earlier copy', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    writeList(s.project, [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }]);
    run(s, 'first');
    rmSync(join(s.base, 'acme/tools'), { recursive: true });
    const r = run(s, 'second');
    assert.ok(existsSync(join(userSkills(s), 'lint/.claude-plugin/plugin.json')));
    assert.deepEqual(r.report.removed, []);
  });

  test('a name already taken, by a folder it did not make or by an earlier source, is skipped', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint', 'plugins/other': 'lint', 'plugins/mine': 'mine' }, 'v1');
    mkdirSync(join(userSkills(s), 'mine'), { recursive: true });
    writeList(s.project, [
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' },
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/other' },
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/mine' },
    ]);
    const r = run(s);
    const why = reasons(r.report);
    assert.match(why, /an earlier source already gave a plugin named "lint"/);
    assert.match(why, /"mine" is taken by a folder plugin-sources did not make/);
    assert.equal(readdirSync(join(userSkills(s), 'mine')).length, 0);
    assert.deepEqual(r.report.delivered.map((d: any) => d.name), ['lint']);
  });
});

describe("plugin-sources reads the environment's own list in a cloud session", () => {
  test('delivers the plugins ~/.claude/plugin-sources.json names, on a repo with no list', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    writeHomeList(s, { plugins: [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }] });
    const r = run(s);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(userSkills(s)), ['lint']);
  });

  test('follows a list on a branch of a public repo, so a commit there reaches the next session', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint', 'plugins/fmt': 'fmt' }, 'v1');
    const list = (paths: string[]) =>
      JSON.stringify({ plugins: paths.map((path) => ({ repo: 'acme/tools', ref: 'v1', path })) });
    commitFiles(s.base, 'acme/env', { 'lists/cloud.json': list(['plugins/lint']) });
    writeHomeList(s, { list: { repo: 'acme/env', branch: 'main', path: 'lists/cloud.json' } });
    const first = run(s, 'first');
    assert.deepEqual(readdirSync(userSkills(s)), ['lint']);
    assert.deepEqual(first.report.lists, [{ repo: 'acme/env', branch: 'main', path: 'lists/cloud.json', fetched: true }]);

    commitFiles(s.base, 'acme/env', { 'lists/cloud.json': list(['plugins/fmt']) });
    const second = run(s, 'second');
    assert.deepEqual(readdirSync(userSkills(s)), ['fmt']);
    assert.deepEqual(second.report.removed, ['lint']);
  });

  test("a repo's plugin comes before the environment's of the same name, and the same entry twice is one plugin", () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint', 'plugins/fmt': 'fmt' }, 'v1');
    makeSource(s.base, 'acme/other', { 'plugins/lint': 'lint' }, 'v1');
    writeList(s.project, [
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' },
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/fmt' },
    ]);
    writeHomeList(s, {
      plugins: [
        { repo: 'acme/other', ref: 'v1', path: 'plugins/lint' },
        { repo: 'acme/tools', ref: 'v1', path: 'plugins/fmt' },
      ],
    });
    const r = run(s);
    assert.equal(readJson(join(userSkills(s), 'lint/.plugin-sources')).repo, 'acme/tools');
    assert.equal(r.report.skipped.length, 1, 'the repeated fmt entry is not a skip');
    assert.match(reasons(r.report), /an earlier source already gave a plugin named "lint"/);
  });

  test('when the followed list cannot be fetched, earlier copies stay and the report says why', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    commitFiles(s.base, 'acme/env', {
      'cloud.json': JSON.stringify({ plugins: [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }] }),
    });
    writeHomeList(s, { list: { repo: 'acme/env', branch: 'main', path: 'cloud.json' } });
    run(s, 'first');
    rmSync(join(s.base, 'acme/env'), { recursive: true });
    const r = run(s, 'second');
    assert.equal(r.status, 0);
    assert.deepEqual(readdirSync(userSkills(s)), ['lint']);
    assert.deepEqual(r.report.removed, []);
    assert.deepEqual(r.report.kept, ['lint']);
    assert.equal(r.report.lists[0].fetched, false);
    assert.match(r.report.lists[0].reason, /cannot fetch acme\/env/);
  });

  test('a followed list pins its plugins like any other, and cannot name a further list', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint', 'plugins/fmt': 'fmt' }, 'v1');
    commitFiles(s.base, 'acme/more', {
      'cloud.json': JSON.stringify({ plugins: [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/fmt' }] }),
    });
    commitFiles(s.base, 'acme/env', {
      'cloud.json': JSON.stringify({
        plugins: [{ repo: 'acme/tools', ref: 'main', path: 'plugins/lint' }],
        list: { repo: 'acme/more', branch: 'main', path: 'cloud.json' },
      }),
    });
    writeHomeList(s, { list: { repo: 'acme/env', branch: 'main', path: 'cloud.json' } });
    const r = run(s);
    assert.ok(!existsSync(userSkills(s)) || readdirSync(userSkills(s)).length === 0);
    assert.match(reasons(r.report), /a branch name is not accepted/);
    assert.equal(r.report.lists.length, 1);
  });

  test('a list entry that is malformed, or a list file that is missing on the branch, is logged and the session starts', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    commitFiles(s.base, 'acme/env', { 'README.md': 'no list here' });
    for (const list of [
      { repo: 'not a repo', branch: 'main', path: 'cloud.json' },
      { repo: 'acme/env', path: 'cloud.json' },
      { repo: 'acme/env', branch: 'main', path: '../cloud.json' },
      { repo: 'acme/env', branch: 'main', path: 'cloud.json' },
      { repo: 'acme/env', branch: 'gone', path: 'cloud.json' },
      'main',
    ]) {
      writeHomeList(s, { plugins: [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }], list });
      const r = run(s, `session-${JSON.stringify(list)}`);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.report.lists.length, 1, JSON.stringify(list));
      assert.equal(r.report.lists[0].fetched, false, JSON.stringify(list));
      assert.ok(r.report.lists[0].reason, JSON.stringify(list));
      assert.deepEqual(readdirSync(userSkills(s)), ['lint'], 'the plugins the file names itself still land');
    }
  });

  test("a local session does not read it: a machine's plugins are installed from the marketplace", () => {
    const s = setup();
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    writeHomeList(s, { plugins: [{ repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' }] });
    const r = run(s);
    assert.equal(r.stdout, '');
    assert.ok(!existsSync(userSkills(s)));
    assert.ok(!existsSync(join(projectSkills(s), 'lint')));
  });
});

describe("plugin-sources runs a delivered plugin's SessionStart hooks in a cloud session", () => {
  test('runs the hook with the session input and its plugin root, and passes on what it prints', () => {
    const s = { ...setup(), remote: true };
    makeHooked(s, [{ hooks: [START] }]);
    writeList(s.project, [{ repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' }]);
    const r = run(s, 'abc');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'greeter: profiles a b\n');
    const input = readJson(join(s.home, 'greeter-input.json'));
    assert.equal(input.session_id, 'abc');
    assert.equal(input.source, 'startup');
    assert.equal(input.hook_event_name, 'SessionStart');
    assert.equal(readFileSync(join(s.home, 'greeter-root'), 'utf-8').trim(), join(userSkills(s), 'greeter'));
    assert.deepEqual(hookStates(r.report), ['greeter: ran']);
  });

  test('a plugin from the environment list gets the same', () => {
    const s = { ...setup(), remote: true };
    makeHooked(s, [{ hooks: [START] }]);
    writeHomeList(s, { plugins: [{ repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' }] });
    assert.equal(run(s).stdout, 'greeter: profiles a b\n');
  });

  test('a plugin left unchanged is not run again: Claude Code loaded it at startup and ran its hooks', () => {
    const s = { ...setup(), remote: true };
    makeHooked(s, [{ hooks: [START] }]);
    writeList(s.project, [{ repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' }]);
    run(s, 'first');
    const r = run(s, 'second');
    assert.equal(r.stdout, '');
    assert.equal(greeterRuns(s), 1);
    assert.deepEqual(hookStates(r.report), []);
  });

  test("a hook with a matcher runs only when it fits the session's source", () => {
    for (const [source, matcher, runs] of [
      ['startup', 'startup|resume', 1],
      ['resume', 'startup|resume', 1],
      ['resume', 'startup', 0],
      ['compact', '', 1],
      ['clear', '*', 1],
    ] as const) {
      const s = { ...setup(), remote: true, source };
      makeHooked(s, [{ matcher, hooks: [START] }]);
      writeList(s.project, [{ repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' }]);
      run(s);
      assert.equal(greeterRuns(s), runs, `${source} against "${matcher}"`);
    }
  });

  test('a hook that fails or runs past its timeout is in the report, and the session starts', () => {
    const s = { ...setup(), remote: true };
    makeHooked(s, [
      {
        hooks: [
          { type: 'command', command: 'echo broken; exit 3' },
          { type: 'command', command: 'sleep 20; echo late', timeout: 1 },
          START,
        ],
      },
    ]);
    writeList(s.project, [{ repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' }]);
    const r = run(s);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'greeter: profiles a b\n', 'a failed hook adds nothing to the context');
    assert.deepEqual(hookStates(r.report), ['greeter: exited 3', 'greeter: timed out', 'greeter: ran']);
  });

  test('structured JSON output is not passed on, and other hook types are not run', () => {
    const s = { ...setup(), remote: true };
    makeHooked(s, [
      {
        hooks: [
          { type: 'command', command: `echo '{"hookSpecificOutput":{"additionalContext":"x"}}'` },
          { type: 'prompt', prompt: 'say hello' },
        ],
      },
    ]);
    writeList(s.project, [{ repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' }]);
    const r = run(s);
    assert.equal(r.stdout, '');
    assert.deepEqual(hookStates(r.report), ['greeter: ran, structured output not used']);
  });

  test('an async hook is started and not waited for', () => {
    const s = { ...setup(), remote: true };
    makeHooked(s, [{ hooks: [{ type: 'command', command: 'sleep 20; echo late', async: true }] }]);
    writeList(s.project, [{ repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' }]);
    const before = Date.now();
    const r = run(s);
    assert.ok(Date.now() - before < 15_000, 'the run did not wait for the hook');
    assert.equal(r.stdout, '');
    assert.deepEqual(hookStates(r.report), ['greeter: started']);
  });

  test('a plugin with no hooks file, or one that is not valid JSON, is delivered all the same', () => {
    const s = { ...setup(), remote: true };
    makeSource(s.base, 'acme/tools', { 'plugins/lint': 'lint' }, 'v1');
    commitFiles(
      s.base,
      'acme/hooked',
      {
        'plugins/greeter/.claude-plugin/plugin.json': JSON.stringify({ name: 'greeter' }),
        'plugins/greeter/hooks/hooks.json': '{ not json',
      },
      'v1',
    );
    writeList(s.project, [
      { repo: 'acme/tools', ref: 'v1', path: 'plugins/lint' },
      { repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' },
    ]);
    const r = run(s);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(userSkills(s)).sort(), ['greeter', 'lint']);
  });

  test('a local session does not run it: the plugin is not loaded until the person reloads', () => {
    const s = setup();
    makeHooked(s, [{ hooks: [START] }]);
    writeList(s.project, [{ repo: 'acme/hooked', ref: 'v1', path: 'plugins/greeter' }]);
    const r = run(s);
    assert.match(notice(r.stdout), /greeter/);
    assert.equal(greeterRuns(s), 0);
  });
});
