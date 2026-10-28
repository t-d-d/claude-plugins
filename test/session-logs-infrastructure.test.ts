import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_ID_PLACEHOLDER,
  asList,
  loadTemplate,
  resourcesOfType,
  type Statement,
  type PolicyDocument,
} from './helpers/cfn.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_LOGS_YML = resolve(__dirname, '../infra/session-logs.cfn.yml');

// ---------------------------------------------------------------------------
// The session-logs bucket is a write-only drop box for Claude Code
// transcripts. Transcripts are the most sensitive thing a session produces
// (every prompt, every tool result, any secret a session was handed), so the
// posture is:
//
//   1. Anonymous writers may PUT, and only PUT, and only under `drop/`, and
//      only when they present one of the writer secrets. No principal
//      outside the account may read or list.
//   2. The secrets are a NoEcho parameter, never a literal in the template.
//   3. Objects are encrypted at rest, ACLs are off (so a writer cannot
//      attach public-read to what it uploads), and versioning is on (so a
//      per-turn overwrite can be rolled back).
//   4. Raw drops expire; digests do not.
//   5. The bucket is named `<BucketPrefix>-<account id>` and the logical ids
//      are fixed, so an existing stack passing its own prefix updates in
//      place rather than replacing the bucket.
//
// Why parse the raw YAML rather than mock the SDK: the YAML is what gets
// deployed.
// ---------------------------------------------------------------------------

const PREFIX = 'acme-session-logs';
const template = loadTemplate(SESSION_LOGS_YML, { 'AWS::AccountId': ACCOUNT_ID_PLACEHOLDER, BucketPrefix: PREFIX });
const BUCKET = `${PREFIX}-${ACCOUNT_ID_PLACEHOLDER}`;
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;

const isPublic = (s: Statement): boolean =>
  s.Principal === '*' || (typeof s.Principal === 'object' && (s.Principal as any)?.AWS === '*');

describe('session-logs bucket template', () => {
  const buckets = resourcesOfType(template, 'AWS::S3::Bucket');
  assert.equal(buckets.length, 1, 'exactly one bucket');
  const [, bucket] = buckets[0]!;
  const props = bucket.Properties!;
  const bucketPolicies = resourcesOfType(template, 'AWS::S3::BucketPolicy').map(([, p]) => p);

  test('BucketPrefix is a parameter defaulting to session-logs', () => {
    const param = template.Parameters?.BucketPrefix;
    assert.ok(param, 'BucketPrefix parameter must exist');
    assert.equal(param.Type, 'String');
    assert.equal(param.Default, 'session-logs');
  });

  test('the logical ids are SessionLogsBucket and SessionLogsBucketPolicy, so an existing stack updates in place', () => {
    assert.deepEqual(Object.keys(template.Resources).sort(), ['SessionLogsBucket', 'SessionLogsBucketPolicy']);
    assert.equal(template.Resources.SessionLogsBucket!.Type, 'AWS::S3::Bucket');
    assert.equal(template.Resources.SessionLogsBucketPolicy!.Type, 'AWS::S3::BucketPolicy');
  });

  test('the bucket is retained on delete and on replacement', () => {
    assert.equal(bucket.DeletionPolicy, 'Retain');
    assert.equal(bucket.UpdateReplacePolicy, 'Retain');
  });

  test('bucket is named <prefix>-<account id> and encrypted, versioned, ACL-free', () => {
    assert.equal(props.BucketName, BUCKET);
    assert.equal(props.VersioningConfiguration?.Status, 'Enabled');
    assert.equal(props.OwnershipControls?.Rules?.[0]?.ObjectOwnership, 'BucketOwnerEnforced');
    const sse = props.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]
      ?.ServerSideEncryptionByDefault?.SSEAlgorithm;
    assert.ok(sse, 'BucketEncryption must set a default SSE algorithm');
  });

  test('public ACLs are blocked; a public bucket policy is permitted', () => {
    const pab = props.PublicAccessBlockConfiguration;
    assert.equal(pab?.BlockPublicAcls, true);
    assert.equal(pab?.IgnorePublicAcls, true);
    assert.equal(pab?.BlockPublicPolicy, false);
    assert.equal(pab?.RestrictPublicBuckets, false);
  });

  test('raw drops expire, noncurrent versions expire, digests are untouched', () => {
    const rules: any[] = props.LifecycleConfiguration?.Rules ?? [];
    const drop = rules.find((r) => r.Prefix === 'drop/');
    assert.ok(drop, 'a lifecycle rule must scope to drop/');
    assert.equal(drop.Status, 'Enabled');
    assert.ok(drop.ExpirationInDays > 0);
    assert.ok(drop.NoncurrentVersionExpiration?.NoncurrentDays > 0);
    assert.ok(!rules.some((r) => r.Prefix === 'digests/'), 'digests/ must not expire');
  });

  test('writer secrets are a NoEcho list parameter', () => {
    const param = (template as any).Parameters?.WriterSecrets;
    assert.ok(param, 'WriterSecrets parameter must exist');
    assert.equal(param.Type, 'CommaDelimitedList');
    assert.equal(param.NoEcho, true);
  });

  test('anonymous access is PutObject under drop/ gated on a writer secret, nothing else', () => {
    const [policy] = bucketPolicies;
    const doc = policy!.Properties!.PolicyDocument as PolicyDocument;
    const publicStatements = (doc.Statement ?? []).filter((s) => isPublic(s) && s.Effect === 'Allow');
    assert.equal(publicStatements.length, 1, 'exactly one anonymous Allow statement');
    const [drop] = publicStatements;
    assert.deepEqual(asList(drop!.Action), ['s3:PutObject']);
    assert.deepEqual(asList(drop!.Resource), [`${BUCKET_ARN}/drop/*`]);
    const referer = drop!.Condition?.StringEquals?.['aws:Referer'];
    assert.equal(referer, '${WriterSecrets}', 'the gate is the WriterSecrets list, by reference');
  });

  test('plain HTTP is denied on the bucket and every object', () => {
    const [policy] = bucketPolicies;
    const doc = policy!.Properties!.PolicyDocument as PolicyDocument;
    const deny = (doc.Statement ?? []).find((s) => s.Effect === 'Deny');
    assert.ok(deny, 'a Deny statement');
    assert.deepEqual([...asList(deny!.Resource)].sort(), [BUCKET_ARN, `${BUCKET_ARN}/*`]);
    assert.equal(deny!.Condition?.Bool?.['aws:SecureTransport'], 'false');
  });

  test('no anonymous read or list anywhere in the policy', () => {
    const [policy] = bucketPolicies;
    const doc = policy!.Properties!.PolicyDocument as PolicyDocument;
    for (const s of (doc.Statement ?? []).filter((st) => isPublic(st) && st.Effect === 'Allow')) {
      for (const action of asList(s.Action)) {
        assert.ok(!/Get|List|Delete|\*/.test(action), `anonymous statement must not grant ${action}`);
      }
    }
  });

  test('the drop URL is an output', () => {
    assert.ok(template.Outputs?.DropUrl, 'DropUrl output');
    assert.match(String(template.Outputs!.DropUrl!.Value), /\/drop$/);
  });
});
