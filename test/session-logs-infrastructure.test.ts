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
  type Statement,
  type PolicyDocument,
} from './helpers/cfn.ts';
import { resolveTemplate } from './helpers/cfn-resolve.ts';

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
//   6. A reader is an IAM role the stack is told about, usually in another
//      account. It may list the bucket, read every object, and write under
//      `digests/`, where it keeps what it distils. It may not write under
//      `drop/` or delete anything. With no reader named, the policy is the
//      two statements it was before readers existed.
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

const WRITERS = ['a'.repeat(48), 'b'.repeat(48)];
const READERS = ['arn:aws:iam::111122223333:role/retro-reader', 'arn:aws:iam::444455556666:role/team/digest-writer'];

/** The bucket policy statements CloudFormation would deploy for this reader list. */
const policyFor = (readers?: string): Statement[] =>
  (resolveTemplate(SESSION_LOGS_YML, {
    BucketPrefix: PREFIX,
    WriterSecrets: WRITERS.join(','),
    ...(readers === undefined ? {} : { ReaderRoleArns: readers }),
  }).Resources.SessionLogsBucketPolicy!.Properties!.PolicyDocument as PolicyDocument).Statement!;

/** The policy before readers existed: what an apply that names none must still deploy. */
const POLICY_WITHOUT_READERS: Statement[] = [
  {
    Sid: 'GatedAnonymousDrop',
    Effect: 'Allow',
    Principal: '*',
    Action: 's3:PutObject',
    Resource: `${BUCKET_ARN}/drop/*`,
    Condition: { StringEquals: { 'aws:Referer': WRITERS } },
  },
  {
    Sid: 'DenyInsecureTransport',
    Effect: 'Deny',
    Principal: '*',
    Action: 's3:*',
    Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
    Condition: { Bool: { 'aws:SecureTransport': 'false' } },
  },
] as Statement[];

const namesReader = (s: Statement): boolean =>
  typeof s.Principal === 'object' && s.Principal !== null && 'AWS' in s.Principal && !isPublic(s);

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

  test('the parameters and outputs an existing stack was applied with keep their names', () => {
    assert.deepEqual(Object.keys(template.Parameters ?? {}).sort(), ['BucketPrefix', 'ReaderRoleArns', 'WriterSecrets']);
    assert.deepEqual(Object.keys(template.Outputs ?? {}).sort(), ['BucketName', 'DropUrl']);
  });
});

describe('session-logs bucket template: readers', () => {
  const withReaders = policyFor(READERS.join(','));
  const readerStatements = withReaders.filter(namesReader);
  const object = (key: string) => `${BUCKET_ARN}/${key}`;

  test('ReaderRoleArns is an optional list, empty by default', () => {
    const param = template.Parameters?.ReaderRoleArns;
    assert.ok(param, 'ReaderRoleArns parameter must exist');
    assert.equal(param.Type, 'CommaDelimitedList');
    assert.equal(param.Default, '');
  });

  test('with no reader the policy is exactly what it was before readers existed', () => {
    assert.deepEqual(policyFor(), POLICY_WITHOUT_READERS, 'ReaderRoleArns omitted');
    assert.deepEqual(policyFor(''), POLICY_WITHOUT_READERS, 'ReaderRoleArns passed empty, as the workflow does');
  });

  test('a reader may list the bucket, read every object, and write under digests/', () => {
    assert.ok(allows(readerStatements, 's3:ListBucket', BUCKET_ARN));
    for (const key of ['drop/laptop/2026-11-01/abc.jsonl.gz', 'digests/2026-11/abc.md', 'anything-else']) {
      assert.ok(allows(readerStatements, 's3:GetObject', object(key)), `reads ${key}`);
    }
    assert.ok(allows(readerStatements, 's3:PutObject', object('digests/2026-11/abc.md')));
  });

  test('a reader cannot write under drop/ or outside digests/, delete, or reconfigure the bucket', () => {
    for (const key of ['drop/laptop/2026-11-01/abc.jsonl.gz', 'drop/digests/x', 'digests', 'digestsX/y', 'top-level']) {
      assert.ok(!allows(readerStatements, 's3:PutObject', object(key)), `must not write ${key}`);
    }
    for (const action of ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObjectAcl', 's3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:DeleteBucket', 's3:PutLifecycleConfiguration']) {
      for (const arn of [BUCKET_ARN, object('drop/x'), object('digests/x')]) {
        assert.ok(!allows(readerStatements, action, arn), `${action} on ${arn}`);
      }
    }
  });

  test('the reader grant is three plain actions, to exactly the roles named', () => {
    assert.deepEqual(readerStatements.flatMap((s) => asList(s.Action)).sort(), ['s3:GetObject', 's3:ListBucket', 's3:PutObject']);
    for (const s of readerStatements) {
      assert.equal(s.Effect, 'Allow');
      assert.deepEqual(s.Principal, { AWS: READERS });
      assert.equal(s.Condition, undefined);
      assert.equal(s.NotAction, undefined);
      assert.equal(s.NotResource, undefined);
    }
    assert.deepEqual((policyFor(READERS[0]).filter(namesReader)[0]!.Principal as any).AWS, [READERS[0]]);
  });

  test('naming readers changes nothing else: the gated drop stays, and plain HTTP is denied to readers too', () => {
    assert.deepEqual(withReaders.filter((s) => !namesReader(s)), POLICY_WITHOUT_READERS);
    const deny = withReaders.find((s) => s.Effect === 'Deny')!;
    assert.equal(deny.Principal, '*', 'the deny names every principal, a reader included');
    assert.deepEqual(asList(deny.Action), ['s3:*']);
    assert.deepEqual([...asList(deny.Resource)].sort(), [BUCKET_ARN, `${BUCKET_ARN}/*`]);
    assert.equal(withReaders.filter((s) => isPublic(s) && s.Effect === 'Allow').length, 1, 'still one anonymous Allow');
  });

  test('a reader must be an IAM role ARN: no wildcard, no account root, no user', () => {
    // A `*` here would make every transcript public: the bucket permits a
    // public policy, for the gated drop. CloudFormation documents the pattern
    // as matched against each value of a list. It is held here to each value,
    // to the whole comma-separated string and to the empty default, so the
    // apply does not depend on which CloudFormation matches.
    const pattern = template.Parameters!.ReaderRoleArns!.AllowedPattern;
    assert.ok(pattern, 'ReaderRoleArns has an AllowedPattern');
    const full = new RegExp(`^(?:${pattern})$`);
    for (const good of ['', ...READERS, READERS.join(',')]) assert.ok(full.test(good), `accepts "${good}"`);
    for (const bad of [`${READERS[0]},*`, `${READERS[0]}, ${READERS[1]}`, `${READERS[0]},`, `,${READERS[0]}`, `${READERS[0]},arn:aws:iam::111122223333:root`]) {
      assert.ok(!full.test(bad), `rejects ${bad}`);
    }
    for (const bad of [
      '*',
      'arn:aws:iam::111122223333:root',
      'arn:aws:iam::111122223333:user/someone',
      'arn:aws:iam::111122223333:role/*',
      'arn:aws:iam::111122223333:role/retro-?',
      'arn:aws:iam::*:role/retro-reader',
      'arn:aws:iam::1111:role/retro-reader',
      'arn:aws:iam::111122223333:role/',
      'arn:aws:sts::111122223333:assumed-role/retro-reader/session',
      '111122223333',
    ]) {
      assert.ok(!full.test(bad), `rejects ${bad}`);
      assert.throws(() => policyFor(bad), /ReaderRoleArns.*AllowedPattern/, `an apply with ${bad} fails`);
    }
    assert.throws(() => policyFor(`${READERS[0]},*`), /ReaderRoleArns.*AllowedPattern/);
  });
});
