# Claude Code Instructions

## Test-driven development

Failing test first. For a bug, widen an existing test or add one, watch it go
red, then fix. For an enhancement, write the high-level test first, then loop
on unit tests until it passes.

## Tests

`npm ci && npm test` (Node 22+, `python3`, `git`, `jq`). CI runs the same on
every push and PR (`.github/workflows/ci.yml`). Tests are `test/**/*.test.ts`,
run by `node --test` with type stripping; shared readers are in
`test/helpers/`.

## Public repo: no private names, no account ids

This repo is public, and a commit pushed to a PR branch stays readable after a
squash merge. `test/public-repo.test.ts` fails on any file naming the private
repo the plugin came from, and on any AWS account id other than AWS's
documented examples (`123456789012`). Run `npm test` before every push, not
after.
