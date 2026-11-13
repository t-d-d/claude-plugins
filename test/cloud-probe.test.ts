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

// ---------------------------------------------------------------------------
// The late plugin answers a second question: does a plugin that lands in a
// plugin folder after Claude Code started get loaded in that session? The
// environment lists an empty folder in CLAUDE_CODE_PLUGIN_DIRS, and the probe
// copies this plugin into it at SessionStart. Its skill shows in the skill
// list if it loads, and its UserPromptSubmit hook leaves a marker if hooks do.
// ---------------------------------------------------------------------------

const LATE = `${PLUGIN}/payload/cloud-probe-late`;

describe('cloud-probe late plugin payload', () => {
  test('carries its own manifest, and the marketplace does not list it', () => {
    assert.equal(readJson(`${LATE}/.claude-plugin/plugin.json`).name, 'cloud-probe-late');
    const names = readJson('.claude-plugin/marketplace.json').plugins.map((p: any) => p.name);
    assert.ok(!names.includes('cloud-probe-late'));
  });

  test('has a skill named after its folder and a command', () => {
    assert.equal(frontmatterName(`${LATE}/skills/cloud-probe-late-check/SKILL.md`), 'cloud-probe-late-check');
    assert.ok(existsSync(join(REPO_ROOT, LATE, 'commands/cloud-probe-late.md')));
  });

  test('registers one UserPromptSubmit hook that runs its marker script', () => {
    const { hooks } = readJson(`${LATE}/hooks/hooks.json`);
    assert.deepEqual(Object.keys(hooks), ['UserPromptSubmit']);
    const all = hooks.UserPromptSubmit.flatMap((g: any) => g.hooks ?? []);
    assert.equal(all.length, 1);
    assert.equal(all[0].command, '"${CLAUDE_PLUGIN_ROOT}"/hooks/marker.sh');
    assert.equal(all[0].timeout, 5);
    assert.ok(statSync(join(REPO_ROOT, LATE, 'hooks/marker.sh')).mode & 0o111);
  });

  test('the marker script appends a line to its log and prints nothing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'probe-late-'));
    const env = { PATH: process.env.PATH ?? '', TMPDIR: tmp };
    const script = join(REPO_ROOT, LATE, 'hooks/marker.sh');
    assert.equal(execFileSync(script, { env, encoding: 'utf-8' }), '');
    execFileSync(script, { env, encoding: 'utf-8' });
    const lines = readFileSync(join(tmp, 'cloud-probe/late-hook.log'), 'utf-8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^fired_at=\d{4}-\d\d-\d\dT/);
  });
});

describe('cloud-probe hook behaviour', () => {
  const run = (remote: string | undefined) => {
    const home = mkdtempSync(join(tmpdir(), 'probe-home-'));
    const tmp = mkdtempSync(join(tmpdir(), 'probe-tmp-'));
    // The setup script makes this folder empty before Claude Code starts.
    const late = mkdtempSync(join(tmpdir(), 'probe-late-dir-'));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: tmp,
      CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, PLUGIN),
      CLAUDE_PROJECT_DIR: '/work/repo',
      CLOUD_PROBE_LATE_DIR: late,
    };
    if (remote !== undefined) env.CLAUDE_CODE_REMOTE = remote;
    const stdout = execFileSync(join(REPO_ROOT, PLUGIN, 'hooks/probe.sh'), { env, encoding: 'utf-8' });
    const log = readFileSync(join(tmp, 'cloud-probe/session-start.log'), 'utf-8');
    return { home, late, stdout, log };
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

  test('in a cloud session it copies the late plugin into the folder, keeping the folder itself', () => {
    const { late, log } = run('true');
    assert.match(log, /^late_dir_before=empty$/m);
    assert.match(log, /^late_plugin=copied$/m);
    assert.equal(JSON.parse(readFileSync(join(late, '.claude-plugin/plugin.json'), 'utf-8')).name, 'cloud-probe-late');
    assert.ok(existsSync(join(late, 'skills/cloud-probe-late-check/SKILL.md')));
  });

  test('outside a cloud session it only logs, and leaves ~/.claude/skills and the late folder alone', () => {
    const { home, late, stdout, log } = run(undefined);
    assert.equal(stdout, '');
    assert.match(log, /^remote=$/m);
    assert.doesNotMatch(log, /payload=|late_plugin=/);
    assert.ok(!existsSync(join(home, '.claude/skills')));
    assert.deepEqual(readdirSync(late), []);
  });
});
