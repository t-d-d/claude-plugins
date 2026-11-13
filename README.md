# claude-plugins

Give every Claude Code session on a repo the same plugins, in the cloud and
on your laptop. Keep a copy of every transcript in a bucket you own. Hold
Claude's writing to one standard across repos.

This is the `t-d-d` plugin marketplace. Each plugin below works on its own;
each links to its full setup.

## plugin-sources

**Plugins that travel with the repo.** A cloud session does not install the
plugins a repo's settings turn on, so a repo has no built-in way to pull in
shared plugins. plugin-sources reads a list the repo commits and loads each
plugin at session start:

```json
{
  "plugins": [
    { "repo": "t-d-d/claude-plugins", "ref": "common-skills--v0.1.0", "path": "plugins/common-skills" }
  ]
}
```

- Every plugin is pinned to a tag or a commit. A branch name is refused, so
  the owner of a source cannot change what your sessions run.
- It works in cloud sessions, including sessions with several repos, and in
  local ones. Load it from the environment's setup script or from one hook in
  the repo's own settings.
- It removes a plugin the list drops, leaves untouched any folder it did not
  make, and never stops a session from starting.

[Set up plugin-sources →](plugins/plugin-sources/README.md)

## session-logs

**Every transcript, in your own S3 bucket.** After each turn, session-logs
uploads the session's transcript to a write-only drop box that you deploy
from this repo as one CloudFormation stack.

- Writers hold no AWS credentials. Each machine or cloud environment gets its
  own secret, which can only add objects. Drop a secret from the stack to
  revoke that writer.
- Each upload records the repo, the branch, and the commit the session
  started on, so you can tell which `CLAUDE.md` and skills it ran under.
- GitHub tokens, AWS keys, Anthropic keys and bearer tokens are redacted
  before upload.
- Install it once on a machine or in a cloud environment and it ships every
  repo's sessions.

[Set up session-logs →](plugins/session-logs/README.md)

## common-skills

**One writing standard for every repo.** Two skills Claude uses wherever the
plugin is loaded:

- `unslop` cuts AI tells from PR descriptions, issue bodies, docs, commit
  messages and chat replies.
- `pr-description` writes a pull request a reviewer can read in one screen.

Load it through plugin-sources, as the list above does. This repo loads it
on itself that way.

[Set up common-skills →](plugins/common-skills/README.md)

## Development

`npm ci && npm test`, with Node 22 or later, `python3`, `git` and `jq`. See
[CLAUDE.md](CLAUDE.md) for how changes are made here.

Apache-2.0. See [LICENSE](LICENSE).
