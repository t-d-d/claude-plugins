import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_ID_PLACEHOLDER,
  allows,
  asList,
  loadTemplate,
  resourcesOfType,
  roleStatements,
} from './helpers/cfn.ts';
import { resolveTemplate, type ResolveOptions } from './helpers/cfn-resolve.ts';

// ---------------------------------------------------------------------------
// The deploy role is what the session-logs workflow assumes. It may apply one
// stack and configure one bucket, and be assumed only from one repo's
// `bootstrap` environment, whose required reviewers are the approval gate.
// Anything wider turns a workflow dispatch into a foothold in the account.
//
// The trust matches GitHub's OIDC subject exactly, and GitHub issues two
// forms of it. A repo created after 15 July 2026 gets one carrying numeric
// ids, `repo:<owner>@<owner id>/<name>@<repo id>:environment:<env>`; an older
// repo keeps `repo:<owner>/<name>:environment:<env>`. The role trusts one
// form, chosen by whether the two id parameters are given, never both, and
// never a pattern that would cover either.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGION = 'us-east-1';
const STACK = 'acme-logs';
const PREFIX = 'acme-session-logs';
const REPO = 'octo/widgets';
const OWNER_ID = '4242';
const REPO_ID = '987654321';
const PROVIDER = `arn:aws:iam::${ACCOUNT_ID_PLACEHOLDER}:oidc-provider/token.actions.githubusercontent.com`;
const NAME_ONLY_SUBJECT = `repo:${REPO}:environment:bootstrap`;
const ID_SUBJECT = `repo:octo@${OWNER_ID}/widgets@${REPO_ID}:environment:bootstrap`;
const SUB = 'token.actions.githubusercontent.com:sub';
const DEPLOY_ROLE_YML = resolve(__dirname, '../infra/deploy-role.cfn.yml');
const template = loadTemplate(DEPLOY_ROLE_YML, {
  'AWS::AccountId': ACCOUNT_ID_PLACEHOLDER,
  'AWS::Region': REGION,
  GitHubRepo: REPO,
  StackName: STACK,
  BucketPrefix: PREFIX,
});

const roles = resourcesOfType(template, 'AWS::IAM::Role');
const [roleId, role] = roles[0]!;
const statements = roleStatements(template, roleId);
const stackArn = (name: string) => `arn:aws:cloudformation:${REGION}:${ACCOUNT_ID_PLACEHOLDER}:stack/${name}/0f1e2d3c-aaaa-bbbb-cccc-0123456789ab`;
const changeSetArn = (name: string) => `arn:aws:cloudformation:${REGION}:${ACCOUNT_ID_PLACEHOLDER}:changeSet/${name}/0f1e2d3c-aaaa-bbbb-cccc-0123456789ab`;
const BUCKET_ARN = `arn:aws:s3:::${PREFIX}-${ACCOUNT_ID_PLACEHOLDER}`;

/** The trust statements CloudFormation would deploy for these id parameters. */
const trustFor = (ids: Record<string, string> = {}, options?: ResolveOptions) =>
  resolveTemplate(DEPLOY_ROLE_YML, { GitHubRepo: REPO, OIDCProviderArn: PROVIDER, ...ids }, options)
    .Resources[roleId]!.Properties!.AssumeRolePolicyDocument.Statement;

describe('deploy-role.cfn.yml', () => {
  test('one role and nothing else, with the six parameters', () => {
    assert.equal(roles.length, 1);
    assert.deepEqual(Object.keys(template.Resources), [roleId]);
    assert.deepEqual(Object.keys(template.Parameters ?? {}).sort(), ['BucketPrefix', 'GitHubOwnerId', 'GitHubRepo', 'GitHubRepoId', 'OIDCProviderArn', 'StackName']);
    assert.equal(template.Parameters!.StackName!.Default, 'session-logs');
    assert.equal(template.Parameters!.BucketPrefix!.Default, 'session-logs');
    assert.equal(template.Parameters!.GitHubOwnerId!.Default, '', 'optional: an older repo gives no ids');
    assert.equal(template.Parameters!.GitHubRepoId!.Default, '', 'optional: an older repo gives no ids');
    assert.deepEqual(Object.keys(template.Outputs ?? {}), ['RoleArn'], 'the role ARN is the one output, for the bootstrap secret');
  });

  test('trust: the existing OIDC provider, only from the named repo\'s bootstrap environment', () => {
    for (const [ids, subject] of [
      [{}, NAME_ONLY_SUBJECT],
      [{ GitHubOwnerId: OWNER_ID, GitHubRepoId: REPO_ID }, ID_SUBJECT],
    ] as const) {
      const trust = trustFor(ids);
      assert.equal(trust.length, 1);
      const [s] = trust;
      assert.equal(s.Effect, 'Allow');
      assert.equal(s.Action, 'sts:AssumeRoleWithWebIdentity');
      assert.deepEqual(s.Principal, { Federated: PROVIDER });
      assert.deepEqual(Object.keys(s.Condition), ['StringEquals'], 'exact match: no StringLike, no wildcard');
      assert.deepEqual(s.Condition.StringEquals, {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        [SUB]: subject,
      });
    }
  });

  test('with both ids the subject is the id-bearing form, and only that', () => {
    const [s] = trustFor({ GitHubOwnerId: OWNER_ID, GitHubRepoId: REPO_ID });
    assert.equal(s.Condition.StringEquals[SUB], 'repo:octo@4242/widgets@987654321:environment:bootstrap');
  });

  test('with neither id the subject stays the name-only form', () => {
    const [s] = trustFor();
    assert.equal(s.Condition.StringEquals[SUB], 'repo:octo/widgets:environment:bootstrap');
    const [explicit] = trustFor({ GitHubOwnerId: '', GitHubRepoId: '' });
    assert.equal(explicit.Condition.StringEquals[SUB], 'repo:octo/widgets:environment:bootstrap');
  });

  test('one id without the other fails the apply', () => {
    assert.throws(() => trustFor({ GitHubOwnerId: OWNER_ID }), /GitHubOwnerId was given without GitHubRepoId/);
    assert.throws(() => trustFor({ GitHubRepoId: REPO_ID }), /GitHubRepoId was given without GitHubOwnerId/);
  });

  test('one id alone never yields the name-only subject, even with the Rules skipped', () => {
    // The Rules are what fail the apply. If an apply ever skipped them, the
    // subject must still not be the name-only form. It is a form GitHub
    // never issues, so the role cannot be assumed at all.
    for (const ids of [{ GitHubOwnerId: OWNER_ID }, { GitHubRepoId: REPO_ID }]) {
      const [s] = trustFor(ids, { rules: false });
      const subject = s.Condition.StringEquals[SUB];
      assert.notEqual(subject, NAME_ONLY_SUBJECT);
      assert.notEqual(subject, ID_SUBJECT);
      assert.match(subject, /^repo:octo@\d*\/widgets@\d*:environment:bootstrap$/);
    }
  });

  test('the ids are digits, and the repo is exactly <owner>/<name>', () => {
    // CloudFormation full-matches an AllowedPattern, so anchor it the same way.
    const full = (name: string) => new RegExp(`^(?:${template.Parameters![name]!.AllowedPattern})$`);
    for (const name of ['GitHubOwnerId', 'GitHubRepoId']) {
      assert.ok(template.Parameters![name]!.AllowedPattern, `${name} has an AllowedPattern`);
      for (const good of ['', '7', OWNER_ID, REPO_ID]) assert.ok(full(name).test(good), `${name} accepts "${good}"`);
      for (const bad of ['*', '42*', '4 2', 'octo', '-1', '4242/1', '42@1']) assert.ok(!full(name).test(bad), `${name} rejects ${bad}`);
    }
    // The template splits GitHubRepo on its slash, so there must be exactly one.
    assert.ok(full('GitHubRepo').test(REPO));
    for (const bad of ['octo', 'octo/', '/widgets', 'octo/widgets/extra', 'octo/wid*', 'octo@1/widgets']) {
      assert.ok(!full('GitHubRepo').test(bad), `GitHubRepo rejects ${bad}`);
    }
    assert.throws(() => trustFor({ GitHubOwnerId: '42*', GitHubRepoId: REPO_ID }), /GitHubOwnerId.*AllowedPattern/);
  });

  test('applies its own stack, continues a stalled rollback, never deletes', () => {
    for (const action of ['CreateStack', 'UpdateStack', 'ContinueUpdateRollback', 'DescribeStacks', 'DescribeStackEvents', 'GetTemplateSummary']) {
      assert.ok(allows(statements, `cloudformation:${action}`, stackArn(STACK)), action);
    }
    for (const action of ['CreateChangeSet', 'ExecuteChangeSet', 'DescribeChangeSet']) {
      assert.ok(allows(statements, `cloudformation:${action}`, changeSetArn(STACK)), action);
      assert.ok(allows(statements, `cloudformation:${action}`, stackArn(STACK)), action);
    }
    assert.ok(!allows(statements, 'cloudformation:DeleteStack', stackArn(STACK)));
  });

  test('no other stack', () => {
    for (const other of ['other-stack', `${STACK}-2`, 'session-logs']) {
      assert.ok(!allows(statements, 'cloudformation:UpdateStack', stackArn(other)), other);
      assert.ok(!allows(statements, 'cloudformation:CreateChangeSet', changeSetArn(other)), other);
    }
  });

  test('configures its own bucket and reaches no object in it', () => {
    for (const action of ['CreateBucket', 'PutBucketPolicy', 'PutBucketPublicAccessBlock', 'PutBucketOwnershipControls', 'PutEncryptionConfiguration', 'PutLifecycleConfiguration', 'PutBucketVersioning']) {
      assert.ok(allows(statements, `s3:${action}`, BUCKET_ARN), action);
    }
    for (const action of ['GetObject', 'PutObject', 'DeleteObject', 'ListBucket', 'DeleteBucket']) {
      assert.ok(!allows(statements, `s3:${action}`, BUCKET_ARN), action);
      assert.ok(!allows(statements, `s3:${action}`, `${BUCKET_ARN}/drop/x`), action);
    }
    assert.ok(!allows(statements, 's3:PutBucketPolicy', `arn:aws:s3:::other-bucket-${ACCOUNT_ID_PLACEHOLDER}`));
  });

  test('the stack name and bucket prefix cannot widen a grant into a wildcard', () => {
    // Both are spliced into ARNs; a `*` or `?` in either would scope the role
    // to every stack or bucket it matches. CloudFormation full-matches an
    // AllowedPattern, so anchor it the same way here.
    for (const name of ['StackName', 'BucketPrefix']) {
      const pattern = template.Parameters![name]!.AllowedPattern;
      assert.ok(pattern, `${name} has an AllowedPattern`);
      const full = new RegExp(`^(?:${pattern})$`);
      assert.ok(full.test('session-logs'), `${name} accepts the default`);
      for (const bad of ['*', 'session-*', 'session-logs?', 'a/b']) assert.ok(!full.test(bad), `${name} rejects ${bad}`);
    }
  });

  test('every grant is scoped to the stack, its change sets or the bucket, bar ValidateTemplate', () => {
    const scoped = new Set([
      `arn:aws:cloudformation:*:${ACCOUNT_ID_PLACEHOLDER}:stack/${STACK}/*`,
      `arn:aws:cloudformation:*:${ACCOUNT_ID_PLACEHOLDER}:changeSet/${STACK}/*`,
      BUCKET_ARN,
    ]);
    for (const s of statements) {
      assert.equal(s.Effect, 'Allow');
      const actions = asList(s.Action);
      for (const action of actions) assert.match(action, /^(cloudformation|s3):[A-Za-z]+$/, `${action}: no wildcard, no other service`);
      for (const resource of asList(s.Resource)) {
        if (resource === '*') assert.deepEqual(actions, ['cloudformation:ValidateTemplate'], 'only ValidateTemplate is unscoped');
        else assert.ok(scoped.has(resource), resource);
      }
    }
  });
});
