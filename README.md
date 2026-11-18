# claude-plugins

Give every Claude Code session on a repo the same plugins, in the cloud and
on your laptop. Keep a copy of every transcript in a bucket you own. Hold
Claude's writing to one standard across repos. Keep email addresses out of
the model's context.

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
  local ones. Load it from the environment's setup script, from one hook in
  the repo's own settings, or once on your machine from the marketplace.
- For plugins you want in every session, whatever the repo, your claude.ai
  account does the job with no setup script. See
  [the account, or a list](plugins/plugin-sources/README.md#the-account-or-a-list).
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

Install it on your claude.ai account to have it in every repo, or load it
for one repo through plugin-sources, as the list above does.

[Set up common-skills →](plugins/common-skills/README.md)

## aws-access

**AWS access with no key in the session.** At session start, aws-access
fetches the session's AWS profiles from an access endpoint, which swaps a
token for credentials that last an hour. The token is a network secret, so
it never enters the session's container.

- It installs the AWS CLI where the machine has none.
- With no endpoint configured it does nothing, so it is safe on every
  environment.
- The endpoint is not in this repo yet, so today this is of use only with an
  endpoint of your own.

[Set up aws-access →](plugins/aws-access/README.md)

## pii-tokenise

**Email addresses the model never reads.** pii-tokenise gives the model a
handle in place of every personal email address in tool output and prompts,
and swaps the address back in when a tool runs.

- The addresses stay on the machine, in a vault that lasts one session.
- A script can require that an address reached it as a handle.
- It narrows what the model sees. It is not an access control.

[Set up pii-tokenise →](plugins/pii-tokenise/README.md)

## session-signoff

**A signed-off session that closes itself.** When a session on your own
machine ends its reply with `Signing off.`, session-signoff asks it to
archive itself with the desktop app's own tool.

- A dispatcher's archive does not close the app's window, and never reaches
  a local session without Remote Control. This does both.
- It does nothing in a cloud session, writes nothing and makes no request.

[Set up session-signoff →](plugins/session-signoff/README.md)

## Development

`npm ci && npm test`, with Node 22 or later, `python3`, `git` and `jq`. See
[CLAUDE.md](CLAUDE.md) for how changes are made here.

A plugin is released by the tag `<name>--v<version>`. A workflow pushes it
when a merge to `main` changes the version in the plugin's manifest. The
marketplace pins each plugin to its tag, so an install gets a release.

Apache-2.0. See [LICENSE](LICENSE).
