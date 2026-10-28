import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflow, assertNoEmptyExpressions, runWorkflowStep, type WorkflowStep } from './helpers/workflow.ts';
import { configuresAwsCredentials, runsCommand } from './helpers/repo-model.ts';

// ---------------------------------------------------------------------------
// The session-logs stack takes its writer secrets from GitHub, one secret per
// writer (SESSION_LOG_WRITER_<NAME>) on the `bootstrap` environment, and a
// human-gated workflow derives the stack's parameter from them. Adding,
// rotating, or removing a writer is one secret, never a retyped comma list.
// The shape that keeps it safe:
//
//   - manual dispatch only, in the `bootstrap` environment (required
//     reviewers), assuming the deploy role (infra/deploy-role.cfn.yml) named
//     by that environment's AWS_DEPLOY_ROLE_ARN secret, and stopping with a
//     notice while that secret is unset (a fresh fork);
//   - the secrets context is read once, filtered by the prefix, and the
//     joined value goes straight into the deploy command in the same step:
//     never into a step output (Actions drops outputs that carry a secret)
//     and never echoed;
//   - every value is validated as a bare token before it is joined, so a
//     stray comma or quote cannot corrupt the parameter or the policy;
//   - the stack name and bucket prefix come from repo variables, defaulting
//     to `session-logs`, and reach the shell through env, never templated
//     into a script.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_YML = resolve(__dirname, '../.github/workflows/session-logs.yml');
const { codeOnly, workflow } = loadWorkflow(WORKFLOW_YML);
const job = workflow.jobs?.apply;
const steps: WorkflowStep[] = job?.steps ?? [];

const deployStep = steps.find(runsCommand('infra/session-logs.cfn.yml'));
const gateStep = steps.find((s) => s.id === 'role');
const WRITER_A = 'a'.repeat(48);
const WRITER_B = '0123456789abcdef'.repeat(3);

/** Runs the deploy step against a stub `aws` that records its arguments. */
function deploy(secrets: Record<string, string>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'session-logs-deploy-'));
  try {
    writeFileSync(join(dir, 'aws'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$AWS_ARGS"\n');
    chmodSync(join(dir, 'aws'), 0o755);
    const stepEnv = Object.fromEntries(Object.entries(deployStep!.env ?? {}).map(([k, v]) => [k, String(v)]));
    const result = runWorkflowStep(deployStep!.run!, {
      ...stepEnv,
      SECRETS_JSON: JSON.stringify(secrets),
      STACK: 'session-logs',
      PREFIX: 'session-logs',
      ...env,
      AWS_ARGS: join(dir, 'args'),
    }, { path: `${dir}:${process.env.PATH}`, cwd: dir, timeout: 30_000 });
    let args: string[] | null = null;
    try {
      args = readFileSync(join(dir, 'args'), 'utf-8').split('\n').filter(Boolean);
    } catch {}
    return { ...result, args };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('session-logs.yml: writer-secret apply workflow', () => {
  test('is named Bootstrap session logs, manual dispatch only', () => {
    assert.equal(workflow.name, 'Bootstrap session logs');
    assert.ok(workflow.on, 'workflow has no triggers');
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  });

  test('runs in the bootstrap environment, assuming the deploy role by OIDC', () => {
    assert.ok(job, 'a job named apply');
    assert.equal(job.environment, 'bootstrap');
    assert.equal(job.permissions?.['id-token'], 'write');
    const creds = steps.find(configuresAwsCredentials);
    assert.ok(creds, 'configure-aws-credentials step');
    assert.match(String(creds!.with?.['role-to-assume']), /^\$\{\{\s*secrets\.AWS_DEPLOY_ROLE_ARN\s*\}\}$/);
  });

  test('stops with a notice while the role secret is unset, and every later step is skipped', () => {
    assert.ok(gateStep, 'a step with id: role checks the secret');
    assert.equal(steps.indexOf(gateStep!), 0, 'the check runs first');
    assert.match(String(gateStep!.env?.ROLE), /secrets\.AWS_DEPLOY_ROLE_ARN/);
    for (const step of steps.slice(1)) {
      assert.match(String(step.if ?? ''), /steps\.role\.outputs\.ready\s*==\s*'true'/, `${step.name ?? step.uses} runs only once the role is set`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'session-logs-gate-'));
    try {
      const out = join(dir, 'out');
      for (const [role, ready] of [['', 'false'], ['arn:aws:iam::123456789012:role/x', 'true']] as const) {
        writeFileSync(out, '');
        const run = runWorkflowStep(gateStep!.run!, { ROLE: role, GITHUB_OUTPUT: out });
        assert.equal(run.status, 0, run.stderr);
        assert.match(readFileSync(out, 'utf-8'), new RegExp(`^ready=${ready}$`, 'm'));
        if (!role) assert.match(run.stdout, /::notice::.*AWS_DEPLOY_ROLE_ARN/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the stack name and bucket prefix come from repo variables, defaulting to session-logs, through env', () => {
    const env = { ...job.env, ...deployStep!.env };
    assert.match(String(env.STACK), /^\$\{\{\s*vars\.SESSION_LOGS_STACK\s*\|\|\s*'session-logs'\s*\}\}$/);
    assert.match(String(env.PREFIX), /^\$\{\{\s*vars\.SESSION_LOGS_BUCKET_PREFIX\s*\|\|\s*'session-logs'\s*\}\}$/);
    for (const step of steps) {
      assert.doesNotMatch(step.run ?? '', /\$\{\{/, `${step.name}: no expression templated into a script`);
    }
  });

  test('deploys the stack with every writer and the bucket prefix', () => {
    const run = deploy(
      { SESSION_LOG_WRITER_B: WRITER_B, SESSION_LOG_WRITER_A: WRITER_A, AWS_DEPLOY_ROLE_ARN: 'x', OTHER: 'y' },
      { STACK: 'acme-logs', PREFIX: 'acme-session-logs' },
    );
    assert.equal(run.status, 0, run.stderr);
    const args = run.args!;
    assert.equal(args[args.indexOf('--stack-name') + 1], 'acme-logs');
    assert.equal(args[args.indexOf('--template-file') + 1], 'infra/session-logs.cfn.yml');
    const overrides = args.slice(args.indexOf('--parameter-overrides') + 1);
    assert.ok(overrides.includes(`WriterSecrets=${WRITER_A},${WRITER_B}`), overrides.join(' '));
    assert.ok(overrides.includes('BucketPrefix=acme-session-logs'), overrides.join(' '));
    assert.match(run.stdout, /Deploying 2 writer\(s\): A, B/);
    for (const line of run.stdout.split('\n').filter((l) => l.includes(WRITER_A))) {
      assert.match(line, /^::add-mask::/, 'a value is printed only to mask it');
    }
  });

  test('refuses to deploy with zero writers or a malformed value', () => {
    for (const secrets of [
      {},
      { SESSION_LOG_WRITER_A: `${WRITER_A}\n` },
      { SESSION_LOG_WRITER_A: `${WRITER_A},${WRITER_B}` },
      { SESSION_LOG_WRITER_A: 'short0123' },
    ]) {
      const run = deploy(secrets);
      assert.notEqual(run.status, 0, JSON.stringify(secrets));
      assert.equal(run.args, null, `aws must not run: ${JSON.stringify(secrets)}`);
    }
  });

  test('the joined value never leaves the step: no output, no echo, masked', () => {
    const run = deployStep!.run!;
    const env = deployStep!.env ?? {};
    assert.ok(Object.values(env).some((v) => /toJSON\(\s*secrets\s*\)/.test(String(v))), 'the deploy step carries toJSON(secrets) in its env');
    assert.ok(!run.includes('GITHUB_OUTPUT'), 'no step output may carry the secrets');
    assert.ok(!run.includes('GITHUB_ENV'), 'no job env may carry the secrets');
    assert.match(run, /::add-mask::/, 'the joined value is masked before use');
    const joined = run.match(/^([A-Z_]+)=\$\(jq .*join\(","\)/m)?.[1];
    assert.ok(joined, 'the joined list is assigned from a jq filter');
    const uses = run.split('\n').filter((l) => l.includes(`$${joined}`) || l.includes(`\${${joined}}`));
    for (const line of uses) {
      assert.ok(/add-mask|WriterSecrets=/.test(line), `unexpected use of ${joined}: ${line.trim()}`);
    }
    assert.ok(!/echo\s+"?\$\{?SECRETS_JSON/.test(run), 'the secrets context is never echoed');
    assert.ok(!/toJSON\(\s*secrets\s*\)/.test(JSON.stringify(job.env ?? {})), 'the secrets context is not in the job env');
  });

  test('continues a stalled rollback before deploying', () => {
    const recover = steps.find(runsCommand('scripts/cfn-continue-stalled-rollback.mjs'));
    assert.ok(recover);
    assert.ok(steps.indexOf(recover!) < steps.indexOf(deployStep!));
    assert.match(recover!.run!, /cfn-continue-stalled-rollback\.mjs "\$STACK"/);
  });

  test('writes nothing but the stack: no Secrets Manager, no other AWS service', () => {
    assert.doesNotMatch(codeOnly, /secretsmanager/);
  });

  test('no empty expressions anywhere in the workflow', () => {
    assertNoEmptyExpressions(steps);
  });
});
