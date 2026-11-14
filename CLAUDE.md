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

## Releases

A plugin is released by the tag `<name>--v<version>`. Change the version in
the plugin's `.claude-plugin/plugin.json`, and the Tag releases workflow
(`.github/workflows/release-tags.yml`) pushes the tag when the change merges
to main. Never ask the owner to tag by hand, and never move a tag.

`environment/plugin-sources.json` is read from main by live sessions. Point
a `ref` there at a new tag in a pull request of its own, after the tag
exists.

## Public repo: no private names, no account ids

This repo is public, and a commit pushed to a PR branch stays readable after a
squash merge. `test/public-repo.test.ts` fails on any file naming the private
repo the plugin came from, and on any AWS account id other than AWS's
documented examples (`123456789012`). Run `npm test` before every push, not
after.
