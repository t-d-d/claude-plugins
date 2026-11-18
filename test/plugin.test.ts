import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';
import { pluginFolder } from '../scripts/lib/marketplace.mjs';

// ---------------------------------------------------------------------------
// The marketplace lists the session-logs plugin, and the plugin registers the
// exporter on the two events it needs. Installed once on a machine or in a
// cloud environment, it ships every repo's sessions, so the registration is
// what makes the export mechanical.
// ---------------------------------------------------------------------------

const readJson = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf-8'));
const PLUGIN = 'plugins/session-logs';
const SCRIPT = '"${CLAUDE_PLUGIN_ROOT}"/hooks/session-log-export.sh';

describe('marketplace', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');

  test('is named t-d-d and lists the session-logs plugin', () => {
    assert.equal(marketplace.name, 't-d-d');
    assert.ok(marketplace.owner?.name, 'a marketplace names its owner');
    const entry = marketplace.plugins.find((p: any) => p.name === 'session-logs');
    assert.ok(entry, 'session-logs is listed');
    assert.equal(pluginFolder(entry), PLUGIN);
  });

  test('the listed plugin carries its manifest under the same name', () => {
    assert.equal(readJson(`${PLUGIN}/.claude-plugin/plugin.json`).name, 'session-logs');
  });

  test('every listed plugin has a folder holding its manifest under the same name', () => {
    // A listing whose folder is gone breaks installs from this marketplace.
    for (const entry of marketplace.plugins) {
      const folder = pluginFolder(entry);
      const manifest = join(REPO_ROOT, folder, '.claude-plugin/plugin.json');
      assert.ok(existsSync(manifest), `${entry.name} is listed but ${folder} has no manifest`);
      assert.equal(readJson(join(folder, '.claude-plugin/plugin.json')).name, entry.name);
    }
  });

  test('every entry pins its plugin to a release tag of that plugin, in this repo', () => {
    // An install gets the plugin as its tag left it, so a merge to main
    // reaches no session until a ref moves. That holds for a plugin
    // installed on a claude.ai account too.
    for (const { name, source } of marketplace.plugins) {
      assert.equal(typeof source, 'object', `${name} is not pinned: an install would get its folder as it is on main`);
      assert.deepEqual(Object.keys(source).sort(), ['path', 'ref', 'source', 'url'], name);
      assert.equal(source.source, 'git-subdir');
      assert.equal(source.url, 'https://github.com/t-d-d/claude-plugins.git');
      assert.equal(source.path, `plugins/${name}`);
      assert.match(source.ref, new RegExp(`^${name}--v\\d+\\.\\d+\\.\\d+$`), `${source.ref} is not a release tag of ${name}`);
    }
  });

  test("no ref is ahead of its plugin's manifest", () => {
    // A ref is not tied to the manifest's version: a tag is pushed after its
    // release merges, so the ref moves in a commit of its own once the tag
    // exists. It may lag the manifest, but a ref ahead of it names a tag
    // nothing has released.
    const numbers = (version: string) => version.split('.').map(Number);
    for (const { name, source } of marketplace.plugins) {
      const pinned = numbers(String(source.ref).split('--v')[1] ?? '');
      const manifest = numbers(readJson(`plugins/${name}/.claude-plugin/plugin.json`).version);
      const ahead = pinned.findIndex((n, i) => n !== manifest[i]);
      assert.ok(ahead === -1 || pinned[ahead] < manifest[ahead], `${name} is pinned to ${source.ref}, ahead of its manifest`);
    }
  });
});

describe('session-logs hook registration', () => {
  const { hooks } = readJson(`${PLUGIN}/hooks/hooks.json`);
  const all = (event: string): any[] => (hooks?.[event] ?? []).flatMap((g: any) => g.hooks ?? []);

  test('a Stop hook runs the export script asynchronously', () => {
    const [hook, ...rest] = all('Stop');
    assert.equal(rest.length, 0, 'one Stop hook');
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, SCRIPT);
    assert.equal(hook.async, true, 'the upload must never delay the turn');
    assert.equal(hook.timeout, 60);
  });

  test('a SessionStart hook seeds the starting commit, and blocks', () => {
    // Stop fires after a turn, so the starting commit has to be taken before
    // turn 1. Blocking (not async) is the point: the first turn must not
    // start before it lands.
    const [hook, ...rest] = all('SessionStart');
    assert.equal(rest.length, 0, 'one SessionStart hook');
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, `${SCRIPT} --seed-commit`);
    assert.notEqual(hook.async, true, 'the seed must land before the first turn runs');
    assert.equal(hook.timeout, 15);
  });

  test('no other event runs it', () => {
    assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop']);
  });

  test('the script it names exists and is executable', () => {
    const path = join(REPO_ROOT, PLUGIN, 'hooks/session-log-export.sh');
    assert.ok(existsSync(path));
    assert.ok(statSync(path).mode & 0o111, 'the hook command runs the script directly');
  });
});

describe('the plugin holds no sign-off code', () => {
  // A session's sign-off is the business of whatever dispatches it, not of a
  // transcript exporter every repo installs.
  test('no sign-off entry point, request or pattern', () => {
    for (const file of ['hooks/session-log-export.sh', 'hooks/session-log-export.py', 'hooks/hooks.json']) {
      const text = readFileSync(join(REPO_ROOT, PLUGIN, file), 'utf-8');
      for (const marker of ['--signoff', 'sign_off', 'signs_off', 'REQUEST', 'SIGN_OFF', 'archive_session']) {
        assert.ok(!text.includes(marker), `${file} carries ${marker}`);
      }
    }
  });
});
