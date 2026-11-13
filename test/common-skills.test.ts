import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// common-skills holds skills that apply to every repo: unslop and
// pr-description. This repo loads it on itself through plugin-sources, so the
// list and the repo hook here pin tags that must follow the plugins'
// versions, and the plugin-sources README's hook snippet must be the one this repo runs.
// ---------------------------------------------------------------------------

const readJson = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf-8'));
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf-8');
const PLUGIN = 'plugins/common-skills';
const SKILLS = ['pr-description', 'unslop'];

const frontmatter = (path: string) => {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(read(path))?.[1] ?? '';
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(head)?.[1]?.trim();
  return { name: field('name'), description: field('description') };
};

describe('common-skills', () => {
  test('is listed, and its manifest carries the same name', () => {
    const entry = readJson('.claude-plugin/marketplace.json').plugins.find((p: any) => p.name === 'common-skills');
    assert.ok(entry);
    assert.equal(entry.source, `./${PLUGIN}`);
    assert.equal(readJson(`${PLUGIN}/.claude-plugin/plugin.json`).name, 'common-skills');
  });

  test('holds exactly the cross-cutting skills, each named after its folder and described', () => {
    assert.deepEqual(readdirSync(join(REPO_ROOT, PLUGIN, 'skills')).sort(), SKILLS);
    for (const skill of SKILLS) {
      const { name, description } = frontmatter(`${PLUGIN}/skills/${skill}/SKILL.md`);
      assert.equal(name, skill);
      assert.ok(description && description.length > 40, `${skill} has a description`);
    }
  });

  test('names no particular repo or its tooling, since every repo loads it', () => {
    for (const skill of SKILLS) {
      const text = read(`${PLUGIN}/skills/${skill}/SKILL.md`);
      for (const marker of ['governor', 't-d-d/', 'pre-push', 'conformance', 'docs/pages']) {
        assert.ok(!text.includes(marker), `${skill} mentions ${marker}`);
      }
    }
  });

  test("unslop keeps its upstream's MIT licence and the note on where it came from", () => {
    const licence = read(`${PLUGIN}/skills/unslop/LICENSE`);
    assert.match(licence, /MIT License/);
    assert.match(licence, /Lauren Tan/);
    assert.match(read(`${PLUGIN}/skills/unslop/UPSTREAM.md`), /github\.com\/cursor\/plugins/);
  });
});

describe('this repo loads common-skills on itself through plugin-sources', () => {
  const version = (plugin: string) => readJson(`plugins/${plugin}/.claude-plugin/plugin.json`).version;

  test("the list pins common-skills to the tag of its manifest's version", () => {
    assert.deepEqual(readJson('.claude/plugin-sources.json'), {
      plugins: [{ repo: 't-d-d/claude-plugins', ref: `common-skills--v${version('common-skills')}`, path: PLUGIN }],
    });
  });

  test("the repo hook runs plugin-sources at the tag of its manifest's version", () => {
    const { hooks } = readJson('.claude/settings.json');
    const all = hooks.SessionStart.flatMap((g: any) => g.hooks ?? []);
    assert.equal(all.length, 1);
    const tag = `plugin-sources--v${version('plugin-sources')}`;
    assert.ok(all[0].command.includes(`--branch ${tag} https://github.com/t-d-d/claude-plugins`), all[0].command);
    assert.ok(all[0].command.includes('/plugins/plugin-sources/hooks/plugin-sources.sh'));
  });

  test("the plugin-sources README's repo-hook snippet is the hook this repo runs", () => {
    const blocks = [...read('plugins/plugin-sources/README.md').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    const snippet = blocks.find((b) => b.includes('"SessionStart"'));
    assert.ok(snippet, 'the plugin-sources README has the snippet');
    assert.deepEqual(JSON.parse(snippet!).hooks, readJson('.claude/settings.json').hooks);
  });

  test('nothing delivered into .claude/skills is committed', () => {
    assert.ok(!existsSync(join(REPO_ROOT, '.claude/skills')) || readdirSync(join(REPO_ROOT, '.claude/skills')).every(
      (child) => existsSync(join(REPO_ROOT, '.claude/skills', child, '.plugin-sources')),
    ));
  });
});
