import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

type Run = { project: string; home: string; tmp: string; base: string; remote?: boolean; session?: string };

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
  const out = spawnSync(HOOK, { input: JSON.stringify({ session_id: session, cwd: s.project, hook_event_name: 'SessionStart' }), env, encoding: 'utf-8' });
  const reportPath = join(s.tmp, 'plugin-sources/report.json');
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, report: existsSync(reportPath) ? readJson(reportPath) : undefined };
};

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
    assert.equal(r.stdout, '');
    assert.equal(readJson(join(projectSkills(s), 'lint/.claude-plugin/plugin.json')).name, 'lint');
    assert.equal(readFileSync(join(projectSkills(s), 'lint/.gitignore'), 'utf-8'), '*\n');
    assert.equal(git(s.project, 'status', '--porcelain'), '', 'git sees nothing new');
    assert.ok(!existsSync(userSkills(s)), 'a local run never writes to ~/.claude/skills');
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
