import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { ACCOUNT_ID_PLACEHOLDER, type Template } from './cfn.ts';
import { deepFreeze } from './repo-model.ts';

// ---------------------------------------------------------------------------
// What CloudFormation would deploy for one set of parameter values.
//
// loadTemplate (cfn.ts) reads a template's shape and leaves an `!If` as a
// placeholder, because which branch applies depends on the parameters. A test
// about a branch names the parameters and reads the result here: parameters
// defaulted and validated, Rules asserted, Conditions and intrinsics
// resolved, AWS::NoValue removed. It throws where the apply would fail.
//
// It models the intrinsics the templates in infra/ use and throws on any
// other, so a template that gains one fails here, not in an assertion that
// read a value nobody resolved. What only a deployed stack knows (a resource's
// `!Ref`, a `!GetAtt`) stays the `${Id}` / `${Id.Attr}` placeholder loadTemplate
// uses.
// ---------------------------------------------------------------------------

export type ResolveOptions = {
  /** Pseudo parameters, over the defaults below. */
  pseudo?: Record<string, string>;
  /** `false` skips the Rules section, to read what the template alone yields. */
  rules?: boolean;
};

const PSEUDO_DEFAULTS: Record<string, string> = {
  'AWS::AccountId': ACCOUNT_ID_PLACEHOLDER,
  'AWS::Partition': 'aws',
  'AWS::Region': 'us-east-1',
  'AWS::StackName': 'test-stack',
  'AWS::URLSuffix': 'amazonaws.com',
};

/** `AWS::NoValue`: the property or list entry holding it is removed. */
const NO_VALUE = Symbol('AWS::NoValue');

const TAGS = ['Ref', 'Sub', 'GetAtt', 'If', 'Equals', 'Not', 'And', 'Or', 'Join', 'Split', 'Select'];

/** Each short-form tag as its long form, `!Sub x` as `{ 'Fn::Sub': x }`, so one evaluator reads both. */
const LONG_FORM_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  TAGS.flatMap((tag) =>
    (['scalar', 'sequence', 'mapping'] as const).map(
      (kind) =>
        new yaml.Type(`!${tag}`, {
          kind,
          construct: (data: unknown) => ({ [tag === 'Ref' ? 'Ref' : `Fn::${tag}`]: data }),
        }),
    ),
  ),
);

type Raw = {
  Parameters?: Record<string, { Type?: string; Default?: unknown; AllowedPattern?: string }>;
  Rules?: Record<string, { RuleCondition?: unknown; Assertions?: { Assert: unknown; AssertDescription?: string }[] }>;
  Conditions?: Record<string, unknown>;
  Resources?: Record<string, Record<string, unknown>>;
  Outputs?: Record<string, Record<string, unknown>>;
};

/**
 * The value of every declared parameter: the one given, else its Default.
 * Values arrive as strings, as they do on a command line. A
 * CommaDelimitedList is split on commas and trimmed; an empty one is no
 * values, but is checked against AllowedPattern as one empty value, since
 * CloudFormation does not say which it does and a pattern that allows the
 * empty value is safe either way.
 */
function parameterValues(raw: Raw, given: Record<string, string>): Record<string, string | string[]> {
  const declared = raw.Parameters ?? {};
  for (const name of Object.keys(given)) {
    if (!(name in declared)) throw new Error(`Parameter ${name} is not declared by the template`);
  }
  return Object.fromEntries(
    Object.entries(declared).map(([name, parameter]) => {
      const value = given[name] ?? parameter.Default;
      if (value === undefined) throw new Error(`Parameter ${name} has no value and no Default`);
      const text = String(value);
      const isList = parameter.Type === 'CommaDelimitedList';
      const values = isList ? text.split(',').map((v) => v.trim()) : [text];
      if (parameter.AllowedPattern !== undefined) {
        // CloudFormation matches the whole value, and each value of a list.
        const pattern = new RegExp(`^(?:${parameter.AllowedPattern})$`);
        for (const v of values) {
          if (!pattern.test(v)) throw new Error(`Parameter ${name} does not match its AllowedPattern ${parameter.AllowedPattern}`);
        }
      }
      return [name, isList ? (text === '' ? [] : values) : text];
    }),
  );
}

/** Resolve a template's text for `parameters`, as {@link resolveTemplate} does a file. */
export function resolveTemplateText(text: string, parameters: Record<string, string> = {}, options: ResolveOptions = {}): Template {
  const raw = (yaml.load(text, { schema: LONG_FORM_SCHEMA }) ?? {}) as Raw;
  const values = parameterValues(raw, parameters);
  const pseudo = { ...PSEUDO_DEFAULTS, ...options.pseudo };
  const resources = raw.Resources ?? {};
  const conditions: Record<string, boolean> = {};

  const truth = (value: unknown, where: string): boolean => {
    if (typeof value !== 'boolean') throw new Error(`${where} takes a condition, and got ${JSON.stringify(value)}`);
    return value;
  };

  /** A name as `!Ref` and `${}` both read it. */
  const named = (name: string, where: string): unknown => {
    if (name === 'AWS::NoValue') return NO_VALUE;
    if (name in values) return values[name];
    if (name in pseudo) return pseudo[name];
    if (name.split('.')[0]! in resources) return `\${${name}}`;
    throw new Error(`${where} names ${name}, which the template does not declare`);
  };

  const sub = (arg: unknown): string => {
    const [body, map] = (Array.isArray(arg) ? arg : [arg, {}]) as [string, Record<string, unknown>];
    const local = Object.fromEntries(Object.entries(map ?? {}).map(([k, v]) => [k, resolve(v)]));
    return body.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      if (name.startsWith('!')) return `\${${name.slice(1)}}`;
      const value = name in local ? local[name] : named(name, 'Fn::Sub');
      if (typeof value !== 'string') throw new Error(`Fn::Sub cannot splice \${${name}}: it is not a string`);
      return value;
    });
  };

  const intrinsic = (name: string, arg: unknown): unknown => {
    const args = (): unknown[] => {
      if (!Array.isArray(arg)) throw new Error(`${name} takes a list`);
      return arg;
    };
    switch (name) {
      case 'Ref':
        return named(String(arg), 'Ref');
      case 'Fn::Sub':
        return sub(arg);
      case 'Fn::GetAtt':
        return `\${${[arg].flat().join('.')}}`;
      case 'Fn::If': {
        const [condition, whenTrue, whenFalse] = args() as [string, unknown, unknown];
        if (!(condition in conditions)) throw new Error(`Fn::If names ${condition}, which is not a condition`);
        return resolve(conditions[condition] ? whenTrue : whenFalse);
      }
      case 'Fn::Equals': {
        const [left, right] = args().map(resolve);
        return String(left) === String(right);
      }
      case 'Fn::Not':
        return !truth(resolve(args()[0]), name);
      case 'Fn::And':
        return args().map(resolve).every((v) => truth(v, name));
      case 'Fn::Or':
        return args().map(resolve).some((v) => truth(v, name));
      case 'Fn::Join': {
        const [delimiter, list] = args().map(resolve) as [string, unknown];
        if (!Array.isArray(list)) throw new Error('Fn::Join takes a list to join');
        return list.join(delimiter);
      }
      case 'Fn::Split': {
        const [delimiter, source] = args().map(resolve) as [string, unknown];
        return String(source).split(delimiter);
      }
      case 'Fn::Select': {
        const [index, list] = args().map(resolve) as [unknown, unknown];
        if (!Array.isArray(list) || !(Number(index) in list)) {
          throw new Error(`Fn::Select cannot take index ${String(index)} of ${JSON.stringify(list)}`);
        }
        return list[Number(index)];
      }
      default:
        throw new Error(`${name} is not modelled by resolveTemplate (test/helpers/cfn-resolve.ts)`);
    }
  };

  function resolve(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(resolve).filter((item) => item !== NO_VALUE);
    if (node === null || typeof node !== 'object') return node;
    const entries = Object.entries(node);
    if (entries.length === 1 && (entries[0]![0] === 'Ref' || entries[0]![0].startsWith('Fn::'))) {
      return intrinsic(entries[0]![0], entries[0]![1]);
    }
    return Object.fromEntries(
      entries.map(([key, value]) => [key, resolve(value)] as const).filter(([, value]) => value !== NO_VALUE),
    );
  }

  if (options.rules !== false) {
    for (const [name, rule] of Object.entries(raw.Rules ?? {})) {
      if (rule.RuleCondition !== undefined && !truth(resolve(rule.RuleCondition), `${name}.RuleCondition`)) continue;
      for (const assertion of rule.Assertions ?? []) {
        if (!truth(resolve(assertion.Assert), `${name}.Assert`)) {
          throw new Error(`Rule ${name} failed: ${assertion.AssertDescription ?? 'no description'}`);
        }
      }
    }
  }

  for (const [name, condition] of Object.entries(raw.Conditions ?? {})) {
    conditions[name] = truth(resolve(condition), `Condition ${name}`);
  }

  /** The entries whose `Condition`, if any, holds. */
  const deployed = (section: Record<string, Record<string, unknown>> | undefined) =>
    Object.fromEntries(
      Object.entries(section ?? {})
        .filter(([, entry]) => {
          const condition = entry.Condition as string | undefined;
          if (condition !== undefined && !(condition in conditions)) throw new Error(`${condition} is not a condition`);
          return condition === undefined || conditions[condition];
        })
        .map(([id, entry]) => [id, resolve(entry)]),
    );

  return deepFreeze({
    Parameters: raw.Parameters,
    Conditions: conditions,
    Resources: deployed(raw.Resources),
    Outputs: deployed(raw.Outputs),
  } as Template);
}

/**
 * What CloudFormation would deploy from the template at `path` for
 * `parameters`. Throws where the apply would fail: an undeclared or
 * unmatched parameter, a failed Rules assertion.
 */
export function resolveTemplate(path: string, parameters: Record<string, string> = {}, options: ResolveOptions = {}): Template {
  return resolveTemplateText(readFileSync(path, 'utf-8'), parameters, options);
}
