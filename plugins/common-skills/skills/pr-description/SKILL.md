---
name: pr-description
description: "Write or rewrite a pull request title and body that a reviewer can read in one screen. Use when raising or updating a pull request, or when asked to tidy a description."
---

# Pull request description

## Who reads it

The person who merges, and anyone reading the repo's history afterwards.
Neither reads the diff first. They want to know whether the change is
going the right way: is it more complicated than it needs to be, and has
it drifted from what the issue or a design record said. Nothing already
decided there is argued again here.

The body is also the record the next person or agent reads to learn what
the system now is.

## Inputs

Fill it from the diff, the issue, and any design records or rules the
change touched. Do not fill it from memory of the session. Read the diff
once more before writing, and read the issue again: an issue edited after
you picked it up changes what the pull request must meet.

## Title

Imperative and specific. It says what changes, and for whom. "Refuse a
link that is not https", not "Fix link validation".

## Body

If the repo has a pull request template, use it: fill every section, strip
the comments, and add no sections. Otherwise use the sections below, in
this order. Aim for about 200 words before *Left for later*. Every
sentence must make sense to someone who has not opened the diff.

**Outcome.** Two or three sentences. What is true after merge that was not
before, for a user, an agent or a developer. State the effect, not the
diagnosis.

**Adds / removes.** One line per thing the system gains or loses: a
module, a route, a flag, a dependency, a permission, a stored item, a test
tier. Removals count. Then one net line: simpler or more complex, and what
the complexity buys. Never "nothing" when a new mechanism exists.

**Drift.** Only where the pull request departs from the issue's acceptance
criteria, a design record, or the obvious approach, and why. A criterion
met differently from its wording goes here, first. "Matches #N as written"
when there is none.

**Closing keywords.** Only the `Closes #N` line at the top puts a closing
word next to an issue number. GitHub matches close, fix or resolve plus
`#N` anywhere in the body and reads no negation, so "does not fix #N"
closes it. Write "#N is not addressed here".

**Verification.** A table with one row per acceptance criterion of each
issue this closes. Every criterion gets a row, including ones nothing
answers yet. The rows come from the issue, never from what the session
chose to test.

`Green at` is one of:

- `merge`: a test that runs on the pull request answers it.
- `deploy`: a check that runs after a deploy answers it, where the repo
  has one.
- `by hand`: only a person can check it. Say exactly what to do.
- an issue number: nothing answers it yet, and that issue owns it. The
  number appears again under *Left for later*.

A dash is not a value. Below the table, say what was not checked and why,
one line each.

**Left for later.** One line per issue filed, with its number and why it
waits. "None" when there is nothing.

## Not in the body

- The story of the work. No "failing test first" or "the review found".
- Test counts, line numbers, commit hashes. A number goes in only when it
  changes what the reader decides.
- A file list. The diff has it.
- A defence of a choice nobody would question.
- A restatement of the issue or a design record. Link it, or say where
  this departs from it.

Run the `unslop` skill over the result.

## Self-check

1. Could a reader who has not opened the diff say in one sentence what
   this adds to the system and what it costs?
2. Is the first sentence of *Drift* the thing most likely to make the
   person merging stop?
3. Does every acceptance criterion appear in the table, and does every
   row that is not green at merge say who checks it or which issue owns it?

## Example

An illustration of the shape, not a real pull request.

> Closes #12
>
> ## Outcome
> `report` can print JSON. A `--json` flag writes the same rows as one
> JSON array, so scripts no longer parse the table. Without the flag the
> output is unchanged.
>
> ## Adds / removes
> - Adds the `--json` flag to `report`.
> - Net: one flag and one output path. No new dependency.
>
> ## Drift
> Matches #12 as written.
>
> ## Verification
> | Acceptance criterion | Answered by | Green at |
> |---|---|---|
> | `--json` prints the rows as a JSON array | `test/report.test.ts` | merge |
> | Without the flag the table is unchanged | `test/report.test.ts` | merge |
> | The README shows the flag | Run the README's example on a real report | by hand |
>
> ## Left for later
> None.
