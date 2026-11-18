import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadTemplate } from './helpers/cfn.ts';
import { codeOnlyOf, REPO_ROOT, runsCommand } from './helpers/repo-model.ts';
import { loadWorkflow } from './helpers/workflow.ts';
import { pluginFolder } from '../scripts/lib/marketplace.mjs';

// ---------------------------------------------------------------------------
// The top README is the pitch: a short entry per plugin, plugin-sources first,
// each linking to the plugin's own README, which holds the instructions. Every
// relative link in any markdown file must resolve, so moving a section cannot
// leave a link behind.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf-8');
const readJson = (path: string) => JSON.parse(read(path));
const plugins: { name: string; source: unknown }[] = readJson('.claude-plugin/marketplace.json').plugins;

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
    for (const entry of plugins) {
      assert.ok(existsSync(join(REPO_ROOT, pluginFolder(entry), 'README.md')), `${entry.name} has no README`);
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

// ---------------------------------------------------------------------------
// A plugin that every session should have goes on a claude.ai account: one
// install reaches every cloud session a person starts, on every environment,
// with no setup script. plugin-sources is for a repo's own list. Its README
// holds the comparison once, and every other plugin's README points there.
//
// This repo's owner followed one list from every environment until the
// plugins moved to the account. That list is gone, and nothing names it.
// ---------------------------------------------------------------------------

describe('READMEs: the account for every session, a list for one repo', () => {
  const HEADING = '## The account, or a list';
  const LINK = '../plugin-sources/README.md#the-account-or-a-list';
  const comparison = () => {
    const readme = read('plugins/plugin-sources/README.md');
    const from = readme.indexOf(`\n${HEADING}\n`);
    assert.ok(from >= 0, `plugin-sources' README has no "${HEADING}" section`);
    const rest = readme.slice(from + HEADING.length + 2);
    const next = rest.indexOf('\n## ');
    return next < 0 ? rest : rest.slice(0, next);
  };

  test("plugin-sources' README compares the two, with what the account does not reach", () => {
    const section = comparison();
    assert.match(section, /claude\.ai/);
    assert.match(section, /Customize/, 'it says where on claude.ai a plugin is installed');
    assert.match(section, /session that another session starts/, 'it names the sessions the account does not reach');
    assert.match(section, /pinned/, 'it says the account gets a pinned release');
  });

  test("it says not to install plugin-sources on the account, where it runs too late", () => {
    assert.match(comparison(), /Do not install plugin-sources itself on the account/);
  });

  test("every other plugin's README gives the account as a way to load it, and links to the comparison", () => {
    for (const { name } of plugins) {
      if (name === 'plugin-sources') continue;
      const readme = read(`plugins/${name}/README.md`);
      assert.match(readme, /claude\.ai account/, `${name}'s README does not name the account`);
      assert.ok(readme.includes(`](${LINK})`), `${name}'s README does not link to the comparison`);
    }
  });

  test('the top README points to the comparison', () => {
    assert.ok(read('README.md').includes('](plugins/plugin-sources/README.md#the-account-or-a-list)'));
  });

  test("the owner's environment list is gone, and no file names it", () => {
    assert.ok(!existsSync(join(REPO_ROOT, 'environment')), 'environment/ is still here');
    const listed = spawnSync('git', ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf-8' });
    // This file names the path to look for it.
    const files = listed.stdout.split('\n').filter((f) => f && f !== 'test/readme.test.ts' && existsSync(join(REPO_ROOT, f)));
    const naming = files.filter((f) => read(f).includes('environment/' + 'plugin-sources.json'));
    assert.deepEqual(naming, []);
  });
});

// ---------------------------------------------------------------------------
// The session-logs README is what a stranger forking the repo follows by hand,
// so what it says about deploying is held to the files: a command names a
// template that exists and parameters it declares, every template and every
// parameter is covered, and the environment table lists what the workflow
// reads, no more and no less.
// ---------------------------------------------------------------------------

describe('session-logs README: deploying, against the files', () => {
  const readme = read('plugins/session-logs/README.md');
  const templatePaths = readdirSync(join(REPO_ROOT, 'infra')).filter((f) => f.endsWith('.cfn.yml')).map((f) => `infra/${f}`);
  const templates = new Map(templatePaths.map((path) => [path, loadTemplate(join(REPO_ROOT, path))]));
  const { workflow } = loadWorkflow(join(REPO_ROOT, '.github/workflows/session-logs.yml'));
  const workflowText = read('.github/workflows/session-logs.yml');

  /** Each `aws cloudformation deploy` in the README: its template and the parameters it passes. */
  const deploys = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => codeOnlyOf(m[1]!.replace(/^ {3}/gm, '')))
    .filter((block) => block.includes('aws cloudformation deploy'))
    .map((block) => ({
      template: block.match(/--template-file (\S+)/)?.[1] ?? '',
      passed: [...(block.split('--parameter-overrides')[1] ?? '').matchAll(/(?:^|[\s"])([A-Za-z]+)=/g)].map((m) => m[1]!),
    }));

  test('every deploy command names a template in infra/ and only parameters it declares', () => {
    assert.ok(deploys.length > 0);
    for (const { template, passed } of deploys) {
      const declared = templates.get(template)?.Parameters;
      assert.ok(templates.has(template), `${template} is not a template in infra/`);
      for (const name of passed) assert.ok(declared && name in declared, `${template} declares no ${name}`);
      for (const [name, parameter] of Object.entries(declared ?? {})) {
        if (parameter.Default === undefined) assert.ok(passed.includes(name), `the ${template} command leaves out ${name}, which has no default`);
      }
    }
  });

  test('every template in infra/ has its deploy command', () => {
    assert.deepEqual([...new Set(deploys.map((d) => d.template))].sort(), [...templatePaths].sort());
  });

  test('every parameter of every template is named', () => {
    for (const [path, template] of templates) {
      for (const name of Object.keys(template.Parameters ?? {})) {
        assert.match(readme, new RegExp(`\\b${name}\\b`), `${path} takes ${name}, which the README never names`);
      }
    }
  });

  test('every stack output it names exists', () => {
    const outputs = new Set([...templates.values()].flatMap((t) => Object.keys(t.Outputs ?? {})));
    const named = [...readme.matchAll(/`([A-Za-z]+)`\s+output/g)].map((m) => m[1]!);
    assert.ok(named.length > 0);
    for (const name of named) assert.ok(outputs.has(name), `no template has a ${name} output`);
  });

  test('the bootstrap environment table lists exactly what the workflow reads', () => {
    const rows = [...readme.matchAll(/^\s*\| `([A-Z_<>]+)` \| (secret|variable) \|/gm)].map((m) => `${m[2]} ${m[1]}`);
    const deployRun: string = workflow.jobs.apply.steps.find(runsCommand('infra/session-logs.cfn.yml')).run;
    const read = [
      ...[...workflowText.matchAll(/\bsecrets\.([A-Z_]+)/g)].map((m) => `secret ${m[1]}`),
      ...[...workflowText.matchAll(/\bvars\.([A-Z_]+)/g)].map((m) => `variable ${m[1]}`),
      // Read out of the secrets JSON by the deploy step: one by name, the writers by prefix.
      ...[...codeOnlyOf(deployRun).matchAll(/\.(SESSION_[A-Z_]+)\b/g)].map((m) => `secret ${m[1]}`),
      ...[...codeOnlyOf(deployRun).matchAll(/^PREFIX_SECRETS='([A-Z_]+)'$/gm)].map((m) => `secret ${m[1]}<NAME>`),
    ];
    assert.deepEqual([...new Set(rows)].sort(), [...new Set(read)].sort());
  });
});

// S3 refuses an upload sent with Transfer-Encoding: chunked, with a 501, and
// curl sends one that way when it reads the body from standard input
// (`-T -`). The hook uploads a file, so it never met this; a check that
// pipes its probe in fails on a drop box that works.
describe('session-logs README: the verify commands', () => {
  const readme = read('plugins/session-logs/README.md');
  const uploads = readme.split('\n').filter((line) => /curl\b.*\s-T\s/.test(line));

  test('each uploads a file, never standard input', () => {
    assert.ok(uploads.length >= 2, `expected the two verify commands, found ${uploads.length}`);
    for (const line of uploads) {
      assert.doesNotMatch(line, /-T\s+-(\s|$)/, `uploads from standard input: ${line.trim()}`);
    }
  });
});
