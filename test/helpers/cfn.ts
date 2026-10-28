import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { makeCfnSchema, type Statement, type Substitutions, type Template } from './cfn-schema.ts';
import { deepFreeze } from './repo-model.ts';

export {
  makeCfnSchema, resourcesOfType,
  type InlinePolicy, type PolicyDocument, type Resource, type ResourceProps, type Statement,
  type Substitutions, type Template, type TemplateOutput, type TemplateParameter,
} from './cfn-schema.ts';

// ---------------------------------------------------------------------------
// The CloudFormation-template reader the infra tests share: an
// intrinsic-tolerant js-yaml schema, a template loader, and IAM-glob and
// policy readers. Substitutions differ per test, so they are a per-call
// parameter rather than baked into the schema.
// ---------------------------------------------------------------------------

/** AWS's documented example account id, for `${AWS::AccountId}`. */
export const ACCOUNT_ID_PLACEHOLDER = '123456789012';

/** Load and parse a CFN template with the shared intrinsic-tolerant schema, frozen. */
export function loadTemplate(path: string, substitutions: Substitutions = {}): Template {
  return deepFreeze(yaml.load(readFileSync(path, 'utf-8'), {
    schema: makeCfnSchema(substitutions),
  }) as Template);
}

// --- IAM glob matching -------------------------------------------------------
// IAM resource ARNs and action strings both glob with `*` (any run, including
// empty) and `?` (any single character). One matcher serves both — exact-string
// matching would let a wildcard-form grant slip past a check unexamined.

/** Compile an IAM glob (`*`, `?`) to an anchored RegExp. */
export function iamGlobToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metachars, leaving * and ?
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`);
}

/** Does an IAM glob (`*`, `?`) match a concrete value end-to-end? */
export const iamGlobMatches = (glob: string, value: string): boolean =>
  iamGlobToRegExp(glob).test(value);

// --- Inline-policy reading ---------------------------------------------------
// Asking "may this role do X on Y?" of a parsed template is the shape every
// role-coverage fitness test wants, and the copies of it drifted the same way
// the schema copies did: one read only the first matching statement,
// another read them all, so the same policy answered two questions. IAM ORs
// its statements, so reading the SET is the only faithful one — and it is what
// lets a grant be split across statements (creation withheld on one set of
// roles, allowed on another) without a test silently reading half of it.

/** A policy field that may be a scalar or a list, as a list. */
export const asList = (value: unknown): string[] =>
  value === undefined ? [] : [value].flat().map(String);

/** Every statement of every inline policy on `logicalId`, a role in `tpl`. */
export function inlinePolicyStatements(tpl: Template, logicalId: string): Statement[] {
  const role = tpl.Resources?.[logicalId];
  if (!role) throw new Error(`${logicalId} is missing from the template`);
  return (role.Properties?.Policies ?? []).flatMap((p) => p.PolicyDocument?.Statement ?? []);
}

/**
 * Every statement `logicalId` holds: its inline policies, each managed
 * policy it attaches, and each policy that names it in `Roles`/`Users`. An
 * attachment this cannot follow — an AWS-managed ARN, a `!Sub` — throws rather than dropping out, because a grant nobody read makes
 * every "the role may not" assertion vacuous.
 */
export function roleStatements(tpl: Template, logicalId: string): Statement[] {
  const managed = asList(tpl.Resources?.[logicalId]?.Properties?.ManagedPolicyArns).flatMap((arn) => {
    const id = /^\$\{([A-Za-z0-9]+)\}$/.exec(arn)?.[1];
    const policy = id === undefined ? undefined : tpl.Resources?.[id];
    if (policy?.Type !== 'AWS::IAM::ManagedPolicy') {
      throw new Error(`${logicalId} attaches ${arn}, which is not a !Ref to a managed policy in this template`);
    }
    return (policy.Properties?.PolicyDocument?.Statement ?? []) as Statement[];
  });
  // A policy can attach itself instead: `Roles:`/`Users:` on the policy, not
  // `ManagedPolicyArns` on the principal.
  const selfAttached = Object.values(tpl.Resources ?? {})
    .filter((r) => r?.Type === 'AWS::IAM::Policy' || r?.Type === 'AWS::IAM::ManagedPolicy')
    .filter((r) => [...asList(r.Properties?.Roles), ...asList(r.Properties?.Users)].includes(`\${${logicalId}}`))
    .flatMap((r) => (r.Properties?.PolicyDocument?.Statement ?? []) as Statement[]);
  return [...inlinePolicyStatements(tpl, logicalId), ...managed, ...selfAttached];
}

/**
 * The older name for `roleStatements`, kept for its callers. It once skipped
 * a managed policy from outside the template, which left their "the role may
 * not" assertions vacuous; it now reads, and throws, as `roleStatements` does.
 */
export const rolePolicyStatements = roleStatements;

/**
 * The `Deny` statements naming `action` on `arn`, both matched as IAM globs.
 * A `NotAction` / `NotResource` Deny covers everything its list does not name.
 * A statement's `Condition` is not read: a conditional Deny counts as denying.
 */
export function denies(statements: Statement[], action: string, arn: string): boolean {
  const covers = (listed: unknown, excluded: unknown, value: string): boolean =>
    excluded === undefined
      ? asList(listed).some((pattern) => iamGlobMatches(pattern, value))
      : !asList(excluded).some((pattern) => iamGlobMatches(pattern, value));
  return statements.some(
    (s) => s.Effect === 'Deny' && covers(s.Action, s.NotAction, action) && covers(s.Resource, s.NotResource, arn),
  );
}

/**
 * The `Allow` statements granting `action`, matched as an IAM glob so a
 * wildcard grant (`lambda:*`) lands rather than slipping past unexamined.
 */
export function statementsAllowing(statements: Statement[], action: string): Statement[] {
  return statements.filter(
    (s) =>
      (s.Effect ?? 'Allow') === 'Allow' &&
      asList(s.Action).some((granted) => iamGlobMatches(granted, action)),
  );
}

/** Do `statements` allow `action` on `arn`? */
export function allows(statements: Statement[], action: string, arn: string): boolean {
  return statementsAllowing(statements, action).some((s) =>
    asList(s.Resource).some((pattern) => iamGlobMatches(pattern, arn)),
  );
}
