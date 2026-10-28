import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflow } from './helpers/workflow.ts';
import { runsCommand } from './helpers/repo-model.ts';

// CI runs the whole suite, the public-repo gate included, on every push and
// every PR.
const __dirname = dirname(fileURLToPath(import.meta.url));
const { workflow } = loadWorkflow(resolve(__dirname, '../.github/workflows/ci.yml'));

test('ci.yml runs npm test on push and on pull_request', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push']);
  const steps = Object.values(workflow.jobs as Record<string, any>).flatMap((j) => j.steps ?? []);
  assert.ok(steps.some(runsCommand(/^npm ci$/m)), 'installs from the lockfile');
  assert.ok(steps.some(runsCommand(/^npm test$/m)), 'runs the suite');
});
