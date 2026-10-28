import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describedStatus, recoveryAction, rollbackCommands } from '../scripts/cfn-continue-stalled-rollback.mjs';

// ---------------------------------------------------------------------------
// The decision the bootstrap applies make before deploying.
//
// CloudFormation's failure states are not interchangeable, and reading them as
// one is how a recoverable stack gets treated as a dead one. Three of them
// stop an apply, and they stop it in two ways:
//
//   UPDATE_ROLLBACK_FAILED  the rollback could not finish. Not updatable, but
//                           `ContinueUpdateRollback` returns it to a state that
//                           is — and the deploy role holds that grant, so CI
//                           recovers this one itself.
//   ROLLBACK_COMPLETE       a failed FIRST create, in its two spellings —
//   ROLLBACK_FAILED         the create's rollback finished, or it failed too.
//                           Delete-only either way (ContinueUpdateRollback
//                           takes UPDATE_ROLLBACK_FAILED and no other state),
//                           and the role holds no DeleteStack, so these need
//                           admin credentials and have to say so rather than
//                           failing later and vaguer.
//
// Everything else proceeds — including UPDATE_ROLLBACK_COMPLETE, which reads
// like a failure and is a working state. `aws cloudformation deploy` is a
// better judge of the rest than a state machine copied out beside it.
// ---------------------------------------------------------------------------

describe('cfn-continue-stalled-rollback — which states stop an apply', () => {
  test('a stalled rollback is continued', () => {
    assert.equal(recoveryAction('UPDATE_ROLLBACK_FAILED'), 'continue');
  });

  test('a failed first create refuses, because clearing it needs a delete', () => {
    // Both spellings of one state: the create rolled back cleanly, or its
    // rollback failed too. `ContinueUpdateRollback` answers for NEITHER — the
    // API takes UPDATE_ROLLBACK_FAILED and nothing else — so both are the
    // delete-only case this script exists to NAME rather than to fix.
    for (const status of ['ROLLBACK_COMPLETE', 'ROLLBACK_FAILED']) {
      assert.equal(recoveryAction(status), 'refuse', status);
    }
  });

  test('a completed rollback proceeds — it is a working state, not a failure', () => {
    assert.equal(recoveryAction('UPDATE_ROLLBACK_COMPLETE'), 'proceed');
  });

  test('a healthy stack proceeds', () => {
    for (const status of ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'IMPORT_COMPLETE']) {
      assert.equal(recoveryAction(status), 'proceed', status);
    }
  });

  test('an absent stack proceeds, so a first create is not special-cased', () => {
    assert.equal(recoveryAction(undefined), 'proceed');
  });

  test('an unrecognised state proceeds and lets the deploy speak for itself', () => {
    // Deliberate: this script exists to unstick one state and name one other.
    // Every status CloudFormation gains later is the deploy's problem to
    // report, not a branch here that will be wrong in a new way.
    assert.equal(recoveryAction('REVIEW_IN_PROGRESS'), 'proceed');
  });
});

describe('cfn-continue-stalled-rollback — reading the stack back', () => {
  test('a described stack hands its status on', () => {
    assert.deepEqual(
      describedStatus({ status: 0, stdout: 'UPDATE_ROLLBACK_FAILED', stderr: '' }),
      { kind: 'status', status: 'UPDATE_ROLLBACK_FAILED' },
    );
  });

  test('CloudFormation saying the stack is not there is absence', () => {
    assert.deepEqual(
      describedStatus({
        status: 254,
        stdout: '',
        stderr: 'An error occurred (ValidationError) when calling the DescribeStacks '
          + 'operation: Stack with id session-logs does not exist',
      }),
      { kind: 'absent' },
    );
  });

  test('any OTHER failed read is unreadable, not an absent stack', () => {
    // The exit code says only that the call failed, so an AccessDenied, a
    // throttle or an unreachable endpoint looks exactly like a stack that is
    // not there. (A wrong REGION is not in this set and cannot be: the region
    // really has no such stack, so CloudFormation says `does not exist` and
    // absence is the honest reading.)
    // Read as absence, a stack genuinely stuck in UPDATE_ROLLBACK_FAILED is
    // never continued — the one job this script has — and the operator is told
    // it does not exist, which sends them to the delete-with-admin-credentials
    // row of infra/README.md and the wrong recovery entirely.
    for (const stderr of [
      'An error occurred (AccessDenied) when calling the DescribeStacks operation: ...',
      'An error occurred (Throttling) when calling the DescribeStacks operation: Rate exceeded',
      'Could not connect to the endpoint URL: "https://cloudformation.us-east-1.amazonaws.com/"',
    ]) {
      assert.deepEqual(describedStatus({ status: 254, stdout: '', stderr }), { kind: 'unreadable' }, stderr);
    }
  });
});

describe('cfn-continue-stalled-rollback — the commands it issues', () => {
  test('it continues the rollback and then waits on a waiter the CLI has', () => {
    // The waiter is a SUBCOMMAND. `aws` matches it against a fixed list and
    // refuses an unknown name before it opens a connection, so a wrong one
    // cannot be caught by anything the stack does — every recovery fails, on
    // the one day a recovery was wanted. `aws cloudformation wait help` is the
    // list; `stack-rollback-complete` is its "wait until stack status is
    // UPDATE_ROLLBACK_COMPLETE", which is precisely what the step below waits
    // for. There is no `stack-update-rollback-complete`.
    assert.deepEqual(rollbackCommands('session-logs'), [
      ['cloudformation', 'continue-update-rollback', '--stack-name', 'session-logs'],
      ['cloudformation', 'wait', 'stack-rollback-complete', '--stack-name', 'session-logs'],
    ]);
  });
});
