import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// cloud-probe is a throwaway plugin. Installed on a claude.ai account, it
// answers four questions in a fresh Claude Code cloud session: does an
// account plugin sync into the session, does its skill load, does its
// SessionStart hook run, and does a skill the hook copies into
// ~/.claude/skills load too. The hook writes what it saw to a log and never
// prints, because a SessionStart hook's output joins the session's context.
// ---------------------------------------------------------------------------

const readJson = (path: string) => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf-8'));
const PLUGIN = 'plugins/cloud-probe';
const SCRIPT = '"${CLAUDE_PLUGIN_ROOT}"/hooks/probe.sh';

const frontmatterName = (path: string) =>
  /^---\n[\s\S]*?^name:\s*(\S+)\s*$/m.exec(readFileSync(join(REPO_ROOT, path), 'utf-8'))?.[1];

describe('cloud-probe listing', () => {
  test('the marketplace lists it from its folder', () => {
    const entry = readJson('.claude-plugin/marketplace.json').plugins.find((p: any) => p.name === 'cloud-probe');
    assert.ok(entry, 'cloud-probe is listed');
    assert.equal(entry.source, `./${PLUGIN}`);
  });

  test('its manifest carries the same name', () => {
    assert.equal(readJson(`${PLUGIN}/.claude-plugin/plugin.json`).name, 'cloud-probe');
  });

  test('it has no top-level bin folder, which claude.ai rejects', () => {
    assert.ok(!existsSync(join(REPO_ROOT, PLUGIN, 'bin')));
  });
});

describe('cloud-probe contents', () => {
  test('its own skill is named after its folder', () => {
    assert.equal(frontmatterName(`${PLUGIN}/skills/cloud-probe-check/SKILL.md`), 'cloud-probe-check');
  });

  test('the payload skill is named after its folder', () => {
    assert.equal(frontmatterName(`${PLUGIN}/payload/cloud-probe-payload/SKILL.md`), 'cloud-probe-payload');
  });

  test('one blocking SessionStart hook runs the probe, and nothing else is registered', () => {
    const { hooks } = readJson(`${PLUGIN}/hooks/hooks.json`);
    assert.deepEqual(Object.keys(hooks), ['SessionStart']);
    const all = hooks.SessionStart.flatMap((g: any) => g.hooks ?? []);
    assert.equal(all.length, 1);
    assert.equal(all[0].type, 'command');
    assert.equal(all[0].command, SCRIPT);
    assert.notEqual(all[0].async, true, 'the payload must be in place before the first turn');
    assert.equal(all[0].timeout, 10);
  });

  test('the probe script exists and is executable', () => {
    const path = join(REPO_ROOT, PLUGIN, 'hooks/probe.sh');
    assert.ok(existsSync(path));
    assert.ok(statSync(path).mode & 0o111);
  });
});

describe('cloud-probe hook behaviour', () => {
  const run = (remote: string | undefined) => {
    const home = mkdtempSync(join(tmpdir(), 'probe-home-'));
    const tmp = mkdtempSync(join(tmpdir(), 'probe-tmp-'));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: tmp,
      CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, PLUGIN),
      CLAUDE_PROJECT_DIR: '/work/repo',
    };
    if (remote !== undefined) env.CLAUDE_CODE_REMOTE = remote;
    const stdout = execFileSync(join(REPO_ROOT, PLUGIN, 'hooks/probe.sh'), { env, encoding: 'utf-8' });
    const log = readFileSync(join(tmp, 'cloud-probe/session-start.log'), 'utf-8');
    return { home, stdout, log };
  };

  test('in a cloud session it logs what it saw and copies the payload skill in', () => {
    const { home, stdout, log } = run('true');
    assert.equal(stdout, '', 'nothing printed, so nothing joins the context');
    assert.match(log, /^remote=true$/m);
    assert.match(log, /^project_dir=\/work\/repo$/m);
    assert.match(log, /^payload=copied$/m);
    const copied = join(home, '.claude/skills/cloud-probe-payload');
    assert.deepEqual(readdirSync(copied), ['SKILL.md']);
  });

  test('outside a cloud session it only logs, and leaves ~/.claude/skills alone', () => {
    const { home, stdout, log } = run(undefined);
    assert.equal(stdout, '');
    assert.match(log, /^remote=$/m);
    assert.doesNotMatch(log, /payload=/);
    assert.ok(!existsSync(join(home, '.claude/skills')));
  });
});
