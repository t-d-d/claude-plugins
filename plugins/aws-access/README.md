# aws-access

At session start, aws-access asks an access endpoint for the session's AWS
profiles and writes them to `~/.aws/config`. If the machine has no AWS CLI,
it installs one. The session holds no AWS key: the endpoint swaps a token
for credentials that last an hour, and the token is a network secret that
never enters the session's container.

This plugin is the session's half. The endpoint is not in this repo yet:
[#15](https://github.com/t-d-d/claude-plugins/issues/15) plans the move.
Until then the plugin is of use only to someone who runs an endpoint that
answers as described below.

## Load it in a cloud environment

Install it on your claude.ai account, under Customize, then Plugins, from
this marketplace. Every session you start then has it, on every environment:
see [the account, or a list](../plugin-sources/README.md#the-account-or-a-list).

Where the account does not reach, name it in a list instead, with
[plugin-sources](../plugin-sources/README.md):

```json
{ "repo": "t-d-d/claude-plugins", "ref": "aws-access--v0.2.0", "path": "plugins/aws-access" }
```

Either way, set these in each environment's settings on claude.ai:

| Setting | Value |
|---|---|
| Environment variable `ACCESS_URL` | The endpoint's URL. It is not secret |
| Network secret, allowed website | The endpoint's host: its URL without `https://` and the last `/` |
| Network secret, header name | `Authorization` |
| Network secret, prefix | `Bearer` |
| Network secret, value | The environment's token |

No setup script is needed for it. The hook installs the CLI, which adds about
six seconds to the start of a session on a fresh machine.

## What the hook does

1. With `ACCESS_URL` unset, as on a laptop, it does nothing at all.
2. It fetches `$ACCESS_URL/config?region=$AWS_REGION`, with `us-east-1` when
   `AWS_REGION` is unset, and writes the answer to `~/.aws/config`. The fetch
   gets ten seconds.
3. It prints the answer's first line, which names the profiles, so the
   session knows them. With `AWS_PROFILE` set it prints a second line:
   `# aws: default profile is <AWS_PROFILE>; a bare aws call uses it`.
4. If `aws` is not on `PATH`, it downloads AWS CLI v2 from
   `awscli.amazonaws.com` and installs it under `/usr/local`, or under
   `AWS_ACCESS_PREFIX` when that is set. A failed install is reported on
   stderr and does not fail the hook. If the environment's network refuses
   the download, add `awscli.amazonaws.com` to its allowed hosts.

It runs on `startup` and `resume`, and again on `clear` and `compact`. A
clear or a compaction rebuilds the context without the lines above, so the
hook fetches again and prints them again. It needs `bash` and `curl`, and
`unzip` for the install. Only Linux on x86_64 or aarch64 gets the install.

### When the fetch fails

A refused request, a fetch that runs out of time and an empty answer all
fail the hook. Each keeps the `~/.aws/config` the session had and leaves no
`~/.aws/config.part` behind. The session is told in its context, in one of
two lines:

```
# aws: could not fetch the profiles (curl exit 22); kept the config fetched earlier
# aws: could not fetch the profiles (curl exit 28); there is no earlier config, so no profile will work
```

An empty answer reads `the access endpoint answered with nothing` in place
of the curl exit. Where a config was kept, its profiles line and the
default-profile line follow.

Claude Code drops the plain output of a hook that fails, so on a failure the
hook prints these lines as one JSON line, `hookSpecificOutput` with
`additionalContext`, which Claude Code reads whatever the exit code. This and
the rerun after a compaction were checked on Claude Code 2.1.330. The rerun
after a clear follows the hooks reference and was not checked.

## What the endpoint must answer

- `GET /config?region=<region>` answers with an AWS config file. Its first
  line is a comment that names the profiles.
- The profiles get their credentials from the endpoint themselves, through
  whatever the config says. The plugin plays no part in that.
- Both requests carry `Authorization: Bearer <token>`, which the
  environment's proxy adds. A request without a good token gets a 401.

## Try it

Start a session on the environment. The hook prints a line that names the
profiles. Then run a read with one of them:

```bash
aws --profile <profile> sts get-caller-identity
```

A hook that fails with `curl exit 22` was refused. A 401 means the token is
wrong, or the network secret's website is not the endpoint's host. `curl exit
28` means the endpoint did not answer in ten seconds.
