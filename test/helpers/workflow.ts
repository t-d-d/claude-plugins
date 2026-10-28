import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { codeOnlyOf, deepFreeze, type WorkflowStep } from './repo-model.ts';

export type { WorkflowStep } from './repo-model.ts';

// Parse a workflow, and derive a comment-free view of the file so assertions
// read the actual shell commands, not the header prose (which names the very
// strings under test when explaining the design).
export function loadWorkflow(path: string): {
  raw: string;
  codeOnly: string;
  workflow: Record<string, any>;
} {
  const raw = readFileSync(path, 'utf-8');
  return { raw, codeOnly: codeOnlyOf(raw), workflow: deepFreeze(yaml.load(raw) as Record<string, any>) };
}

// The bash invocation a GitHub runner gives a `run:` step with no `shell:`.
export const GITHUB_BASH = ['--noprofile', '--norc', '-eo', 'pipefail', '-c'] as const;

/**
 * Runs a step's `run:` script the way a GitHub runner does, with `env` and
 * nothing else from this process but PATH, so a case asserts what the script
 * does, not what its text says.
 */
export function runWorkflowStep(
  script: string,
  env: Record<string, string>,
  { path = process.env.PATH ?? '', cwd, timeout }: { path?: string; cwd?: string; timeout?: number } = {},
) {
  return spawnSync('bash', [...GITHUB_BASH, script], {
    env: { PATH: path, ...env },
    encoding: 'utf-8',
    cwd,
    timeout,
  });
}

// GitHub templates ${{ }} everywhere it appears, including inside run:
// scripts, so an empty expression is an "invalid workflow file" failure.
export function assertNoEmptyExpressions(steps: WorkflowStep[]): void {
  for (const s of steps) {
    if (!s.run) continue;
    assert.ok(
      !/\$\{\{\s*\}\}/.test(s.run),
      `step "${s.name ?? s.id}" has an empty \${{ }} in its run script — GitHub would reject the workflow`,
    );
  }
}
