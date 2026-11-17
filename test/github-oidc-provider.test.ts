import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_ID_PLACEHOLDER, loadTemplate, resourcesOfType } from './helpers/cfn.ts';

// ---------------------------------------------------------------------------
// The deploy role trusts the account's GitHub Actions OIDC provider, and a new
// account has none. This template creates it. It is a stack of its own: an
// account holds one provider per URL, and the deploy roles of every project
// in the account trust the same one, so no project's stack can own it.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDER_YML = resolve(__dirname, '../infra/github-oidc-provider.cfn.yml');
const template = loadTemplate(PROVIDER_YML);
const raw = readFileSync(PROVIDER_YML, 'utf-8');
const providers = resourcesOfType(template, 'AWS::IAM::OIDCProvider');
const [providerId, provider] = providers[0]!;

describe('github-oidc-provider.cfn.yml', () => {
  test('one OIDC provider and nothing else, with no parameters', () => {
    assert.equal(providers.length, 1);
    assert.deepEqual(Object.keys(template.Resources), [providerId]);
    assert.deepEqual(Object.keys(template.Parameters ?? {}), []);
  });

  test("it is GitHub Actions' issuer, for tokens addressed to STS", () => {
    const props = provider.Properties!;
    assert.equal(props.Url, 'https://token.actions.githubusercontent.com');
    assert.deepEqual(props.ClientIdList, ['sts.amazonaws.com']);
  });

  test('it carries one thumbprint: a SHA-1 in hex', () => {
    const thumbprints = provider.Properties!.ThumbprintList;
    assert.equal(thumbprints.length, 1);
    assert.match(String(thumbprints[0]), /^[0-9a-f]{40}$/);
  });

  test('ProviderArn is the one output, and is the provider\'s ARN', () => {
    assert.deepEqual(Object.keys(template.Outputs ?? {}), ['ProviderArn']);
    assert.ok(
      [`\${${providerId}}`, `\${${providerId}.Arn}`].includes(String(template.Outputs!.ProviderArn!.Value)),
      'a !Ref of an OIDC provider and its Arn attribute are both the ARN',
    );
  });

  test('the ARN it creates is one the deploy role accepts as OIDCProviderArn', () => {
    const host = new URL(provider.Properties!.Url).host;
    const arn = `arn:aws:iam::${ACCOUNT_ID_PLACEHOLDER}:oidc-provider/${host}`;
    const pattern = loadTemplate(resolve(__dirname, '../infra/deploy-role.cfn.yml')).Parameters!.OIDCProviderArn!.AllowedPattern;
    assert.match(arn, new RegExp(`^(?:${pattern})$`));
  });

  test('its comments say why it is its own stack, and when to skip it', () => {
    const comments = raw.split('\n').filter((l) => l.trimStart().startsWith('#')).join(' ').replace(/[#\s]+/g, ' ');
    assert.match(comments, /one provider per URL/);
    assert.match(comments, /[Ss]kip/);
    assert.match(comments, /already (has|holds)/);
  });
});
