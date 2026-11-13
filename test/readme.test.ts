import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// The top README is the pitch: a short entry per plugin, plugin-sources first,
// each linking to the plugin's own README, which holds the instructions. Every
// relative link in any markdown file must resolve, so moving a section cannot
// leave a link behind.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf-8');
const readJson = (path: string) => JSON.parse(read(path));
const plugins: { name: string; source: string }[] = readJson('.claude-plugin/marketplace.json').plugins;

/** Relative link targets in a markdown file, without their #fragment. */
function relativeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((href) => !/^[a-z]+:/i.test(href) && !href.startsWith('#'))
    .map((href) => href.split('#')[0]);
}

describe('README', () => {
  const readme = read('README.md');

  test('every listed plugin has its own README', () => {
    for (const { name, source } of plugins) {
      assert.ok(existsSync(join(REPO_ROOT, source, 'README.md')), `${name} has no README`);
    }
  });

  test('links every listed plugin to its README, plugin-sources first', () => {
    const at = (name: string) => readme.indexOf(`](plugins/${name}/README.md)`);
    for (const { name } of plugins) assert.ok(at(name) >= 0, `README does not link ${name}'s README`);
    for (const { name } of plugins) {
      if (name !== 'plugin-sources') assert.ok(at('plugin-sources') < at(name), `${name} comes before plugin-sources`);
    }
  });

  test('stays short: the instructions live in the plugin READMEs', () => {
    assert.ok(readme.split('\n').length <= 120, `README is ${readme.split('\n').length} lines`);
  });

  test('every relative link in a markdown file resolves', () => {
    const listed = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { encoding: 'utf-8' });
    const files = listed.stdout.split('\n').filter(Boolean);
    assert.ok(files.includes('README.md'));
    const broken = files.flatMap((file) =>
      relativeLinks(read(file))
        .filter((href) => !existsSync(join(REPO_ROOT, dirname(file), href)))
        .map((href) => `${file}: ${href}`),
    );
    assert.deepEqual(broken, []);
  });
});
