import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// This repo is public, and a commit pushed to a PR branch stays readable after
// a squash merge. So no file may name the private repo the plugin was moved
// out of, and no file may carry an AWS account id. The private repo's name is
// assembled here so this file does not trip its own check.
// ---------------------------------------------------------------------------

const PRIVATE_NAME = new RegExp(['pod', 'stow'].join(''), 'i');

// Twelve digits standing alone: an account id, bare or inside an ARN or a
// bucket name. AWS's own documented example ids are allowed, since tests and
// docs need one.
const ACCOUNT_ID = /(?<!\d)\d{12}(?!\d)/g;
const EXAMPLE_IDS = new Set(['123456789012', '111122223333', '444455556666']);

export function findings(path: string, text: string): string[] {
  const found: string[] = [];
  if (PRIVATE_NAME.test(path) || PRIVATE_NAME.test(text)) found.push(`${path}: names the private repo`);
  for (const id of text.match(ACCOUNT_ID) ?? []) {
    if (!EXAMPLE_IDS.has(id)) found.push(`${path}: carries an account id, ${id}`);
  }
  return found;
}

/** Every file git would commit: tracked, plus untracked files not ignored. */
function repoFiles(): string[] {
  const listed = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf-8' });
  assert.equal(listed.status, 0, listed.stderr);
  return [...new Set(listed.stdout.split('\0').filter(Boolean))];
}

describe('public-repo gate', () => {
  test('fails on the private repo name, in any case, and on an account id', () => {
    const id = ['2109876', '54321'].join('');
    const name = ['Pod', 'Stow'].join('');
    assert.notDeepEqual(findings('README.md', `see ${name.toUpperCase()}`), []);
    assert.notDeepEqual(findings(`docs/${name.toLowerCase()}.md`, ''), []);
    assert.notDeepEqual(findings('infra/x.yml', `arn:aws:iam::${id}:role/x`), []);
    assert.notDeepEqual(findings('x.md', `bucket session-logs-${id}`), []);
  });

  test('passes AWS example ids and longer digit runs', () => {
    assert.deepEqual(findings('x.md', 'arn:aws:iam::123456789012:role/x'), []);
    assert.deepEqual(findings('x.md', 'epoch ms 1761696000000'), []);
  });

  test('no file in the repo fails it', () => {
    const files = repoFiles();
    assert.ok(files.length > 0);
    const found = files.flatMap((path) => {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, path), 'utf-8');
      } catch {
        return [];
      }
      return findings(path, text);
    });
    assert.deepEqual(found, []);
  });
});
