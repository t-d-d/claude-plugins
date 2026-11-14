#!/usr/bin/env node
//
// Tag the checked-out commit for each plugin whose version has no tag yet.
//
// A plugin is released by a tag, <name>--v<version>, which lists and setup
// scripts pin. The Tag releases workflow (.github/workflows/release-tags.yml)
// runs this on every push to main, so a merge that changes a plugin's
// manifest version releases it and nobody tags by hand:
//
//   node scripts/release-tags.mjs
//
// Run from the repo's root. It reads the plugins the marketplace lists, asks
// origin which tags exist, and makes and pushes an annotated tag for each
// version that has none. A tag that exists is never moved: a list pins it so
// that what a session runs cannot change under it.
//
// Every version is checked before anything is tagged, so a bad manifest
// tags nothing.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from './lib/cli-entry.mjs';

const VERSION = /^\d+\.\d+\.\d+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

/**
 * The tag each listed plugin's manifest asks for.
 *
 * @param {string} root the repo's root
 * @returns {{ name: string, version: string, tag: string }[]}
 */
export function wantedTags(root) {
  const { plugins } = readJson(join(root, '.claude-plugin/marketplace.json'));
  return plugins.map(({ name, source }) => {
    const { version } = readJson(join(root, source, '.claude-plugin/plugin.json'));
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`a listed plugin has no usable name: ${name}`);
    if (typeof version !== 'string' || !VERSION.test(version)) {
      throw new Error(`${name} has version ${JSON.stringify(version)}; a release is three numbers, such as 1.2.3`);
    }
    return { name, version, tag: `${name}--v${version}` };
  });
}

function git(root, ...args) {
  const done = spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
  if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(done.stderr || '').trim()}`);
  return done.stdout;
}

/** The tags origin holds. */
function existingTags(root) {
  return new Set(
    git(root, 'ls-remote', '--tags', 'origin')
      .split('\n')
      .map((line) => line.split('\t')[1])
      .filter(Boolean)
      .map((ref) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')),
  );
}

function main(root) {
  const wanted = wantedTags(root);
  const existing = existingTags(root);
  const missing = wanted.filter(({ tag }) => !existing.has(tag));
  if (missing.length === 0) {
    console.log('Every listed version has its tag; nothing to tag.');
    return;
  }
  for (const { name, version, tag } of missing) {
    git(root, 'tag', '-a', tag, '-m', `${name} ${version}`);
    git(root, 'push', 'origin', `refs/tags/${tag}`);
    console.log(`Tagged ${tag}.`);
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  try {
    main(process.cwd());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
