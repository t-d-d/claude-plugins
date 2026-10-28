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

// ---------------------------------------------------------------------------
// The deploy role is what the session-logs workflow assumes. It may apply one
// stack and configure one bucket, and be assumed only from one repo's
// `bootstrap` environment, whose required reviewers are the approval gate.
// Anything wider turns a workflow dispatch into a foothold in the account.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGION = 'us-east-1';
const STACK = 'acme-logs';
const PREFIX = 'acme-session-logs';
const REPO = 'octo/widgets';
const template = loadTemplate(resolve(__dirname, '../infra/deploy-role.cfn.yml'), {
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

describe('deploy-role.cfn.yml', () => {
  test('one role and nothing else, with the four parameters', () => {
    assert.equal(roles.length, 1);
    assert.deepEqual(Object.keys(template.Resources), [roleId]);
    assert.deepEqual(Object.keys(template.Parameters ?? {}).sort(), ['BucketPrefix', 'GitHubRepo', 'OIDCProviderArn', 'StackName']);
    assert.equal(template.Parameters!.StackName!.Default, 'session-logs');
    assert.equal(template.Parameters!.BucketPrefix!.Default, 'session-logs');
    assert.ok(template.Outputs?.RoleArn, 'the role ARN is an output, for the bootstrap secret');
  });

  test('trust: the existing OIDC provider, only from the named repo\'s bootstrap environment', () => {
    const trust = role.Properties!.AssumeRolePolicyDocument.Statement;
    assert.equal(trust.length, 1);
    const [s] = trust;
    assert.equal(s.Effect, 'Allow');
    assert.equal(s.Action, 'sts:AssumeRoleWithWebIdentity');
    assert.deepEqual(s.Principal, { Federated: '${OIDCProviderArn}' });
    assert.deepEqual(Object.keys(s.Condition), ['StringEquals'], 'exact match: no StringLike, no wildcard');
    assert.deepEqual(s.Condition.StringEquals, {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:${REPO}:environment:bootstrap`,
    });
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
