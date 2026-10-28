import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// The repo root, the workflow step shape and the step locators the workflow
// suites share.
// ---------------------------------------------------------------------------

export const REPO_ROOT = resolve(import.meta.dirname, '../..');

export type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  id?: string;
  // js-yaml parses unquoted scalar env values (`FOO: 1`, `FOO: true`) as
  // number/boolean, so this is not string-only in general.
  env?: Record<string, string | number | boolean>;
  with?: Record<string, string | number | boolean>;
};

/** Which steps a question is about. */
export type StepLocator = (step: WorkflowStep) => boolean;

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Comment-free view of a workflow: continuations joined, `#` lines dropped. */
export const codeOnlyOf = (raw: string): string =>
  raw
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

/** A step's `run:` as {@link codeOnlyOf} reads a workflow. */
const runCode = (step: WorkflowStep): string => codeOnlyOf(step.run ?? '');

/** A step that uses `action`, at any ref. */
export const usesAction = (action: string): StepLocator =>
  (step) => step.uses === action || (step.uses ?? '').startsWith(`${action}@`);

/** A step whose `run:` carries `command`: a substring, or a pattern. */
export const runsCommand = (command: string | RegExp): StepLocator => {
  if (typeof command === 'string') return (step) => runCode(step).includes(command);
  // A /g or /y pattern's `test` resumes from its lastIndex.
  const pattern = new RegExp(command.source, command.flags.replace(/[gy]/g, ''));
  return (step) => pattern.test(runCode(step));
};

/** The step that assumes an AWS role. */
export const configuresAwsCredentials: StepLocator = usesAction('aws-actions/configure-aws-credentials');
