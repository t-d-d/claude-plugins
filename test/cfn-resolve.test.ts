import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_ID_PLACEHOLDER } from './helpers/cfn.ts';
import { resolveTemplateText } from './helpers/cfn-resolve.ts';

// ---------------------------------------------------------------------------
// resolveTemplate answers "what would CloudFormation deploy for these
// parameters?", so the infra suites can assert on a branch of an `!If` rather
// than on the template's text. A wrong answer here makes those assertions
// vacuous, so the evaluator is pinned on a fixture that uses each thing the
// templates do.
// ---------------------------------------------------------------------------

const FIXTURE = `
Parameters:
  Name:
    Type: String
    AllowedPattern: '[a-z]+'
  Extra:
    Type: String
    Default: ''
  Items:
    Type: CommaDelimitedList
    Default: ''
    AllowedPattern: '([a-z]+)?'
Rules:
  ExtraNeedsItems:
    RuleCondition: !Not [!Equals [!Ref Extra, '']]
    Assertions:
      - Assert: !Not [!Equals [!Join ['', !Ref Items], '']]
        AssertDescription: Extra was given without Items
Conditions:
  HasExtra: !Not [!Equals [!Ref Extra, '']]
  HasItems: !Not [!Equals [!Join ['', !Ref Items], '']]
  HasEither: !Or [!Not [!Equals [!Ref Extra, '']], !Not [!Equals [!Join ['', !Ref Items], '']]]
  HasBoth: !And [!Not [!Equals [!Ref Extra, '']], !Not [!Equals [!Join ['', !Ref Items], '']]]
Resources:
  Thing:
    Type: Test::Thing
    DeletionPolicy: Retain
    Properties:
      Label: !If [HasExtra, !Sub '\${Name}-\${Extra}', !Ref Name]
      Arn: !Sub 'arn:aws:s3:::\${Name}-\${AWS::AccountId}'
      Owner: !Select [0, !Split ['/', !Join ['/', [!Ref Name, tail]]]]
      Joined: !Join ['', ['a:', !Ref Name, ':z']]
      List:
        - fixed
        - !If
          - HasItems
          - Each: !Ref Items
          - !Ref AWS::NoValue
      Optional: !If [HasItems, 'set', !Ref AWS::NoValue]
      Self: !GetAtt Thing.Arn
      Literal: !Sub 'keep \${!Name} and \${Thing}'
  Gated:
    Type: Test::Thing
    Condition: HasItems
Outputs:
  Id:
    Value: !Ref Thing
  GatedId:
    Condition: HasItems
    Value: !Ref Gated
`;

const resolve = (parameters: Record<string, string>, options?: { rules?: boolean }) =>
  resolveTemplateText(FIXTURE, parameters, options);

describe('resolveTemplate', () => {
  test('defaults apply, the false branch is taken, and AWS::NoValue removes the entry', () => {
    const tpl = resolve({ Name: 'abc' });
    const props = tpl.Resources.Thing!.Properties!;
    assert.equal(props.Label, 'abc');
    assert.equal(props.Arn, `arn:aws:s3:::abc-${ACCOUNT_ID_PLACEHOLDER}`);
    assert.equal(props.Owner, 'abc');
    assert.equal(props.Joined, 'a:abc:z');
    assert.deepEqual(props.List, ['fixed'], 'a NoValue list element is dropped, not left as a hole');
    assert.ok(!('Optional' in props), 'a NoValue property is dropped');
    assert.deepEqual(tpl.Conditions, { HasExtra: false, HasItems: false, HasEither: false, HasBoth: false });
  });

  test('a list parameter splits on commas, and the true branch carries it', () => {
    const tpl = resolve({ Name: 'abc', Extra: 'x', Items: 'one, two' });
    const props = tpl.Resources.Thing!.Properties!;
    assert.equal(props.Label, 'abc-x');
    assert.deepEqual(props.List, ['fixed', { Each: ['one', 'two'] }]);
    assert.equal(props.Optional, 'set');
    assert.deepEqual(tpl.Conditions, { HasExtra: true, HasItems: true, HasEither: true, HasBoth: true });
    assert.deepEqual(resolve({ Name: 'abc', Items: 'one' }).Conditions, { HasExtra: false, HasItems: true, HasEither: true, HasBoth: false });
  });

  test('a resource or output whose condition is false is not deployed', () => {
    assert.deepEqual(Object.keys(resolve({ Name: 'abc' }).Resources), ['Thing']);
    assert.deepEqual(Object.keys(resolve({ Name: 'abc' }).Outputs!), ['Id']);
    assert.deepEqual(Object.keys(resolve({ Name: 'abc', Items: 'one' }).Resources), ['Thing', 'Gated']);
    assert.deepEqual(Object.keys(resolve({ Name: 'abc', Items: 'one' }).Outputs!), ['Id', 'GatedId']);
  });

  test('what only a deployed stack knows stays a placeholder; resource attributes are kept', () => {
    const tpl = resolve({ Name: 'abc' });
    assert.equal(tpl.Resources.Thing!.Properties!.Self, '${Thing.Arn}');
    assert.equal(tpl.Resources.Thing!.Properties!.Literal, 'keep ${Name} and ${Thing}');
    assert.equal(tpl.Outputs!.Id!.Value, '${Thing}');
    assert.equal(tpl.Resources.Thing!.DeletionPolicy, 'Retain');
    assert.equal(tpl.Resources.Thing!.Type, 'Test::Thing');
  });

  test('a failed Rules assertion fails the apply, naming the rule', () => {
    assert.throws(() => resolve({ Name: 'abc', Extra: 'x' }), /ExtraNeedsItems.*Extra was given without Items/);
    assert.equal(resolve({ Name: 'abc', Extra: 'x' }, { rules: false }).Resources.Thing!.Properties!.Label, 'abc-x');
  });

  test('a bad parameter fails the apply: missing, undeclared, or off its AllowedPattern', () => {
    assert.throws(() => resolve({}), /Name/);
    assert.throws(() => resolve({ Name: 'abc', Nmae: 'x' }), /Nmae/);
    assert.throws(() => resolve({ Name: 'ABC' }), /Name.*AllowedPattern/);
    assert.throws(() => resolve({ Name: 'abc-' }), /AllowedPattern/, 'the pattern must match the whole value');
    assert.throws(() => resolve({ Name: 'abc', Items: 'one,TWO' }), /Items.*AllowedPattern/, 'a list is checked value by value');
  });

  test('an intrinsic or reference it does not model throws rather than passing through', () => {
    const base = 'Parameters: {}\nResources:\n  T:\n    Type: Test::Thing\n    Properties:\n';
    assert.throws(() => resolveTemplateText(`${base}      A: !Ref Nowhere\n`), /Nowhere/);
    assert.throws(() => resolveTemplateText(`${base}      A: !Sub '\${Nowhere}'\n`), /Nowhere/);
    assert.throws(() => resolveTemplateText(`${base}      A: !If [Missing, a, b]\n`), /Missing/);
    assert.throws(() => resolveTemplateText(`${base}      A: !Select [3, [a, b]]\n`), /Select/);
    assert.throws(() => resolveTemplateText(`${base}      A:\n        Fn::Base64: x\n`), /Fn::Base64/);
  });
});
