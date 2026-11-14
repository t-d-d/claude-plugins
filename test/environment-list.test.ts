import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// environment/plugin-sources.json is the list the owner's cloud environments
// follow on main: each setup script names it, and plugin-sources fetches it in
// every session. A commit to it changes what all of those sessions load, so
// the file is held to what plugin-sources accepts.
//
// A ref here is not tied to the plugin's manifest version, as the repo's own
// list is. A tag is pushed after its release merges, and sessions read this
// file from main at once, so the ref moves in a commit of its own once the
// tag exists.
// ---------------------------------------------------------------------------

const LIST = 'environment/plugin-sources.json';
const readJson = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf-8'));

describe("the owner's environment list", () => {
  const list = readJson(LIST);

  test('holds plugins only: a followed list cannot name a further list', () => {
    assert.deepEqual(Object.keys(list), ['plugins']);
    assert.ok(Array.isArray(list.plugins) && list.plugins.length > 0);
  });

  test('every entry is a plugin of this repo, pinned to a release tag of that plugin', () => {
    for (const entry of list.plugins) {
      assert.deepEqual(Object.keys(entry).sort(), ['path', 'ref', 'repo'], JSON.stringify(entry));
      assert.equal(entry.repo, 't-d-d/claude-plugins');
      const manifest = join(REPO_ROOT, entry.path, '.claude-plugin/plugin.json');
      assert.ok(existsSync(manifest), `${entry.path} is not a plugin folder`);
      const { name } = JSON.parse(readFileSync(manifest, 'utf-8'));
      assert.match(entry.ref, new RegExp(`^${name}--v\\d+\\.\\d+\\.\\d+$`), `${entry.ref} is not a release tag of ${name}`);
    }
  });

  test('names each plugin once', () => {
    const paths = list.plugins.map((p: any) => p.path);
    assert.deepEqual(paths, [...new Set(paths)]);
  });

  test('ships transcripts from every environment', () => {
    assert.ok(list.plugins.some((p: any) => p.path === 'plugins/session-logs'));
  });

  test('gives every environment that has an access endpoint its AWS profiles', () => {
    // On an environment with no ACCESS_URL the plugin does nothing.
    assert.ok(list.plugins.some((p: any) => p.path === 'plugins/aws-access'));
  });

  test('the plugin-sources README points to it as the example', () => {
    const readme = readFileSync(join(REPO_ROOT, 'plugins/plugin-sources/README.md'), 'utf-8');
    assert.ok(readme.includes(`](../../${LIST})`));
  });
});
