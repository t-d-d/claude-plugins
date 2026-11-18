import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadWorkflow } from './helpers/workflow.ts';
import { REPO_ROOT, runsCommand } from './helpers/repo-model.ts';
import { pluginFolder } from '../scripts/lib/marketplace.mjs';

// ---------------------------------------------------------------------------
// A plugin is released by a tag, <name>--v<version>, that lists and setup
// scripts pin. The Tag releases workflow pushes it: on every push to main it
// runs scripts/release-tags.mjs, which tags the pushed commit for each listed
// plugin whose manifest version has no tag yet. Nobody tags by hand.
//
// A tag that exists is never moved. A list pins it so that what a session
// runs cannot change under it.
//
// The script runs here against a throwaway repo and a bare remote, so no
// test touches the network.
// ---------------------------------------------------------------------------

const SCRIPT = resolve(REPO_ROOT, 'scripts/release-tags.mjs');
const { workflow } = loadWorkflow(resolve(REPO_ROOT, '.github/workflows/release-tags.yml'));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

/**
 * A repo with a bare remote as its origin. `plugins` maps a plugin's name to
 * its version. `source` gives the marketplace entry's source for a name, and
 * is the plugin's folder unless a test says otherwise.
 */
const setup = (plugins: Record<string, string>, source: (name: string) => unknown = (name) => `./plugins/${name}`) => {
  const root = mkdtempSync(join(tmpdir(), 'release-tags-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  mkdirSync(repo);
  git(root, 'init', '-q', '--bare', remote);
  git(repo, 'init', '-q');
  git(repo, 'remote', 'add', 'origin', remote);
  const write = (versions: Record<string, string>, message: string) => {
    mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(repo, '.claude-plugin/marketplace.json'),
      JSON.stringify({ plugins: Object.keys(versions).map((name) => ({ name, source: source(name) })) }),
    );
    for (const [name, version] of Object.entries(versions)) {
      mkdirSync(join(repo, 'plugins', name, '.claude-plugin'), { recursive: true });
      writeFileSync(join(repo, 'plugins', name, '.claude-plugin/plugin.json'), JSON.stringify({ name, version }));
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', message);
    git(repo, 'push', '-q', 'origin', 'HEAD:main');
    return git(repo, 'rev-parse', 'HEAD');
  };
  const first = write(plugins, 'first');
  return { repo, remote, write, first };
};

const run = (repo: string) =>
  spawnSync('node', [SCRIPT], {
    cwd: repo,
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    },
  });

/** The remote's tags, each with the commit it leads to. */
const remoteTags = (remote: string): Record<string, string> =>
  Object.fromEntries(
    git(remote, 'tag', '-l')
      .split('\n')
      .filter(Boolean)
      .map((tag) => [tag, git(remote, 'rev-parse', `${tag}^{commit}`)]),
  );

describe('scripts/release-tags.mjs', () => {
  test('tags the checked-out commit for each listed plugin whose version has no tag', () => {
    const s = setup({ alpha: '0.1.0', beta: '2.3.4' });
    const r = run(s.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(remoteTags(s.remote), { 'alpha--v0.1.0': s.first, 'beta--v2.3.4': s.first });
    assert.match(r.stdout, /alpha--v0\.1\.0/);
    assert.match(r.stdout, /beta--v2\.3\.4/);
  });

  test('the tags are annotated, as the ones made by hand were', () => {
    const s = setup({ alpha: '0.1.0' });
    run(s.repo);
    assert.equal(git(s.remote, 'cat-file', '-t', 'alpha--v0.1.0'), 'tag');
  });

  test('a later push tags only the plugin whose version changed, and never moves a tag', () => {
    const s = setup({ alpha: '0.1.0', beta: '2.3.4' });
    run(s.repo);
    const second = s.write({ alpha: '0.2.0', beta: '2.3.4' }, 'alpha 0.2.0');
    const r = run(s.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(remoteTags(s.remote), {
      'alpha--v0.1.0': s.first,
      'alpha--v0.2.0': second,
      'beta--v2.3.4': s.first,
    });
    assert.doesNotMatch(r.stdout, /beta--v2\.3\.4/);
  });

  test('with every version tagged it does nothing and says so', () => {
    const s = setup({ alpha: '0.1.0' });
    run(s.repo);
    const r = run(s.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to tag/);
  });

  test('a version that is not three numbers is refused, and nothing is tagged', () => {
    const s = setup({ alpha: '0.1.0', beta: 'main' });
    const r = run(s.repo);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /beta/);
    assert.deepEqual(remoteTags(s.remote), {});
  });

  test('a plugin the marketplace pins to a tag is read from its folder, and its new version is tagged', () => {
    // The pinned ref is the release an install gets. The version to tag is
    // still the one in the folder's manifest on the pushed commit.
    const pinned = (name: string) => ({
      source: 'git-subdir',
      url: 'https://example.com/acme/plugins.git',
      path: `plugins/${name}`,
      ref: `${name}--v0.1.0`,
    });
    const s = setup({ alpha: '0.2.0', beta: '2.3.4' }, (name) => (name === 'alpha' ? pinned(name) : `./plugins/${name}`));
    const r = run(s.repo);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(remoteTags(s.remote), { 'alpha--v0.2.0': s.first, 'beta--v2.3.4': s.first });
  });

  test('a source that names no folder of this repo is refused by name, and nothing is tagged', () => {
    const s = setup({ alpha: '0.1.0', beta: '2.3.4' }, (name) =>
      name === 'beta' ? { source: 'github', repo: 'acme/elsewhere' } : `./plugins/${name}`,
    );
    const r = run(s.repo);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /beta has a source/);
    assert.deepEqual(remoteTags(s.remote), {});
  });

  test('a remote that refuses the push fails the run', () => {
    const s = setup({ alpha: '0.1.0' });
    git(s.repo, 'remote', 'set-url', '--push', 'origin', join(s.remote, 'gone'));
    const r = run(s.repo);
    assert.notEqual(r.status, 0);
  });
});

describe('.github/workflows/release-tags.yml', () => {
  const jobs = Object.values(workflow.jobs as Record<string, any>);
  const steps = jobs.flatMap((j) => j.steps ?? []);

  test('runs on a push to main and on nothing else', () => {
    assert.deepEqual(workflow.on, { push: { branches: ['main'] } });
  });

  test('may write contents, which a tag push needs, and holds no other permission', () => {
    assert.deepEqual(workflow.permissions, { contents: 'write' });
    for (const job of jobs) assert.equal(job.permissions, undefined);
  });

  test('one run at a time, so two merges cannot both make the same tag', () => {
    assert.ok(workflow.concurrency, 'the workflow names a concurrency group');
    assert.notEqual(workflow.concurrency['cancel-in-progress'], true, 'a queued run still tags its own commit');
  });

  test('checks out the pushed commit and runs the script as the Actions bot', () => {
    assert.ok(steps.some((s: any) => /^actions\/checkout@/.test(s.uses ?? '')));
    assert.ok(steps.some(runsCommand(/^node scripts\/release-tags\.mjs$/m)));
    assert.ok(steps.some(runsCommand(/git config user\.name "github-actions\[bot\]"/)));
  });
});

describe('this repo', () => {
  test('every listed plugin has a version the script accepts', () => {
    const { plugins } = JSON.parse(execFileSync('cat', [join(REPO_ROOT, '.claude-plugin/marketplace.json')], { encoding: 'utf-8' }));
    for (const entry of plugins) {
      const { name } = entry;
      const manifest = JSON.parse(execFileSync('cat', [join(REPO_ROOT, pluginFolder(entry), '.claude-plugin/plugin.json')], { encoding: 'utf-8' }));
      assert.match(manifest.version, /^\d+\.\d+\.\d+$/, `${name} has version ${manifest.version}`);
    }
  });
});
