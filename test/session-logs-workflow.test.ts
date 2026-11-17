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
//     into a script;
//   - the readers (SESSION_LOGS_READER_ARNS, optional) come out of the same
//     secrets JSON in the same step, each validated as an IAM role ARN and
//     masked, and the parameter is passed on every apply, empty included:
//     `aws cloudformation deploy` keeps the previous value of a parameter it
//     is not given, so deleting the secret would otherwise remove nobody;
//   - the repo is public and so is its run log, where only secrets are
//     masked. The bucket name ends in the account id, so the credentials step
//     masks the id before any step can print it.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_YML = resolve(__dirname, '../.github/workflows/session-logs.yml');
const { codeOnly, workflow } = loadWorkflow(WORKFLOW_YML);
const job = workflow.jobs?.apply;
const steps: WorkflowStep[] = job?.steps ?? [];

const deployStep = steps.find(runsCommand('infra/session-logs.cfn.yml'));
const gateStep = steps.find((s) => s.id === 'role');
const credsStep = steps.find(configuresAwsCredentials);
const showStep = steps.find(runsCommand('DropUrl'));
const WRITER_A = 'a'.repeat(48);
const WRITER_B = '0123456789abcdef'.repeat(3);
const READER_A = 'arn:aws:iam::111122223333:role/retro-reader';
const READER_B = 'arn:aws:iam::444455556666:role/team/digest-writer';

/** The values after `--parameter-overrides` in a recorded `aws` call. */
const overridesOf = (args: string[]): string[] => args.slice(args.indexOf('--parameter-overrides') + 1);

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
    assert.ok(credsStep, 'configure-aws-credentials step');
    assert.match(String(credsStep!.with?.['role-to-assume']), /^\$\{\{\s*secrets\.AWS_DEPLOY_ROLE_ARN\s*\}\}$/);
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
    const overrides = overridesOf(args);
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

  test('passes the readers from SESSION_LOGS_READER_ARNS, each one masked', () => {
    const run = deploy({ SESSION_LOG_WRITER_A: WRITER_A, SESSION_LOGS_READER_ARNS: `${READER_A},${READER_B}`, AWS_DEPLOY_ROLE_ARN: 'x' });
    assert.equal(run.status, 0, run.stderr);
    const overrides = overridesOf(run.args!);
    assert.ok(overrides.includes(`ReaderRoleArns=${READER_A},${READER_B}`), overrides.join(' '));
    assert.ok(overrides.includes(`WriterSecrets=${WRITER_A}`), 'the reader secret is not taken for a writer');
    const lines = run.stdout.split('\n');
    for (const reader of [READER_A, READER_B]) {
      assert.ok(lines.includes(`::add-mask::${reader}`), `${reader} is masked on its own, so it is hidden wherever it is printed alone`);
    }
    for (const line of lines.filter((l) => l.includes('arn:aws:iam'))) {
      assert.match(line, /^::add-mask::/, 'a reader is printed only to mask it');
    }
    assert.doesNotMatch(run.stderr, /arn:aws:iam/);
    assert.match(run.stdout, /2 reader\(s\)/);
  });

  test('always passes ReaderRoleArns, empty when the secret is unset, so deleting it removes the readers', () => {
    const run = deploy({ SESSION_LOG_WRITER_A: WRITER_A });
    assert.equal(run.status, 0, run.stderr);
    const overrides = overridesOf(run.args!);
    assert.ok(overrides.includes('ReaderRoleArns='), overrides.join(' '));
    assert.deepEqual(overrides.filter((o) => o.startsWith('ReaderRoleArns')), ['ReaderRoleArns=']);
    assert.doesNotMatch(run.stdout, /::add-mask::$/m, 'no empty mask: the runner warns on one');
    assert.match(run.stdout, /0 reader\(s\)/);
  });

  test('refuses a reader that is not an IAM role ARN, without printing it', () => {
    for (const readers of [
      '*',
      'arn:aws:iam::111122223333:root',
      'arn:aws:iam::111122223333:user/someone',
      'arn:aws:iam::111122223333:role/*',
      'arn:aws:iam::1111:role/retro-reader',
      `${READER_A}, ${READER_B}`,
      `${READER_A}\n`,
      `${READER_A},`,
      `${READER_A},*`,
      `${READER_A};${READER_B}`,
    ]) {
      const run = deploy({ SESSION_LOG_WRITER_A: WRITER_A, SESSION_LOGS_READER_ARNS: readers });
      assert.notEqual(run.status, 0, JSON.stringify(readers));
      assert.equal(run.args, null, `aws must not run: ${JSON.stringify(readers)}`);
      assert.match(run.stderr, /::error::.*SESSION_LOGS_READER_ARNS/);
      assert.doesNotMatch(run.stdout + run.stderr, /111122223333|444455556666/, 'the error names the secret, not its value');
    }
  });

  test('a joined value never leaves the step: no output, no echo, masked', () => {
    const run = deployStep!.run!;
    const env = deployStep!.env ?? {};
    assert.ok(Object.values(env).some((v) => /toJSON\(\s*secrets\s*\)/.test(String(v))), 'the deploy step carries toJSON(secrets) in its env');
    assert.ok(!run.includes('GITHUB_OUTPUT'), 'no step output may carry the secrets');
    assert.ok(!run.includes('GITHUB_ENV'), 'no job env may carry the secrets');
    assert.match(run, /::add-mask::/, 'the joined value is masked before use');
    // Both lists are joined by a jq filter into one variable each, and each
    // variable goes to its mask or its parameter and nowhere else.
    const joined = [...run.matchAll(/^([A-Z_]+)=\$\(jq .*join\(","\)/gm)].map((m) => m[1]!);
    assert.equal(joined.length, 2, `the writer list and the reader list: ${joined.join(', ')}`);
    const parameters: string[] = [];
    for (const name of joined) {
      const uses = run.split('\n').filter((l) => l.includes(`$${name}`) || l.includes(`\${${name}}`));
      const parameter = uses.map((l) => l.match(new RegExp(`"([A-Za-z]+)=\\$\\{${name}\\}"`))?.[1]).find(Boolean);
      assert.ok(parameter, `${name} reaches a stack parameter`);
      parameters.push(parameter!);
      for (const line of uses) {
        assert.ok(line.includes('add-mask') || line.includes(`${parameter}=\${${name}}`), `unexpected use of ${name}: ${line.trim()}`);
      }
    }
    assert.deepEqual(parameters.sort(), ['ReaderRoleArns', 'WriterSecrets']);
    // What the joined values are built from goes to jq on stdin and nowhere else.
    for (const name of ['SECRETS_JSON', 'WRITERS', 'READERS']) {
      const uses = run.match(new RegExp(`\\$\\{?${name}\\b`, 'g'))?.length ?? 0;
      const piped = run.split(`<<<"$${name}"`).length - 1;
      assert.ok(uses > 0, `${name} is read`);
      assert.equal(uses, piped, `${name} is only ever a here-string into jq`);
    }
    assert.ok(!/echo\s+"?\$\{?SECRETS_JSON/.test(run), 'the secrets context is never echoed');
    assert.ok(!/toJSON\(\s*secrets\s*\)/.test(JSON.stringify(job.env ?? {})), 'the secrets context is not in the job env');
  });

  test('the secrets context is read in one place: no secret named beyond the deploy role', () => {
    assert.equal(codeOnly.match(/toJSON\(\s*secrets\s*\)/g)?.length, 1, 'one toJSON(secrets), in the deploy step');
    const named = [...codeOnly.matchAll(/\bsecrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(named)], ['AWS_DEPLOY_ROLE_ARN'], 'the readers and writers are read out of SECRETS_JSON, not named in an expression');
    for (const step of steps.filter((s) => s !== deployStep)) {
      assert.doesNotMatch(JSON.stringify(step), /SECRETS_JSON|toJSON/, `${step.name ?? step.uses} holds no secrets JSON`);
    }
  });

  test('the account id is masked before any step can print it', () => {
    // Anyone can read a public repo's run log. configure-aws-credentials
    // masks the id only when asked, and (v6) only on the path that exports
    // the credentials to the environment, which a profile turns off.
    assert.ok(credsStep, 'configure-aws-credentials step');
    assert.equal(String(credsStep!.with?.['mask-aws-account-id']), 'true');
    assert.ok(!('aws-profile' in (credsStep!.with ?? {})), 'a profile skips the masking');
    assert.notEqual(String(credsStep!.with?.['output-env-credentials']), 'false', 'so does not exporting the credentials');
    const talksToAws = steps.filter(runsCommand(/\baws\s|cfn-continue-stalled-rollback/));
    assert.ok(talksToAws.length >= 3, 'the rollback check, the deploy and the drop URL');
    for (const step of talksToAws) {
      assert.ok(steps.indexOf(step) > steps.indexOf(credsStep!), `${step.name} runs after the id is masked`);
    }
    assert.doesNotMatch(codeOnly, /get-caller-identity|outputs\.aws-account-id|AWS_ACCOUNT_ID/, 'no step asks for the id');
  });

  test('the last step shows the drop URL and says where the unmasked one is', () => {
    assert.ok(showStep, 'a step reads the DropUrl output');
    assert.equal(steps.indexOf(showStep!), steps.length - 1);
    assert.match(String(showStep!.name), /\*\*\*/, 'the step name says the id shows as ***');
    const dir = mkdtempSync(join(tmpdir(), 'session-logs-show-'));
    try {
      // The runner, not the script, replaces the id with ***. The script's
      // part is to print the output and tell the reader what they are seeing.
      writeFileSync(join(dir, 'aws'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$AWS_ARGS"\necho "https://acme-session-logs-123456789012.s3.us-east-1.amazonaws.com/drop"\n');
      chmodSync(join(dir, 'aws'), 0o755);
      const run = runWorkflowStep(showStep!.run!, { STACK: 'acme-logs', AWS_ARGS: join(dir, 'args') }, { path: `${dir}:${process.env.PATH}`, cwd: dir });
      assert.equal(run.status, 0, run.stderr);
      const args = readFileSync(join(dir, 'args'), 'utf-8').split('\n');
      assert.equal(args[args.indexOf('--stack-name') + 1], 'acme-logs');
      assert.match(run.stdout, /^https:\/\/acme-session-logs-123456789012\.s3\.us-east-1\.amazonaws\.com\/drop$/m);
      assert.match(run.stdout, /\*\*\*/, 'says the id shows as ***');
      assert.match(run.stdout, /acme-logs.*DropUrl output/, 'says where the real value is');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
