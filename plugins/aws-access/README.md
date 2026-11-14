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

Name it in the list the environment follows, with
[plugin-sources](../plugin-sources/README.md) 0.3.0 or later:

```json
{ "repo": "t-d-d/claude-plugins", "ref": "aws-access--v0.1.0", "path": "plugins/aws-access" }
```

Then, in the environment's settings on claude.ai:

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
   `AWS_REGION` is unset, and writes the answer to `~/.aws/config`. It prints
   the answer's first line, which names the profiles, so the session knows
   them. A refused request fails the hook and keeps the config the session
   had.
3. If `aws` is not on `PATH`, it downloads AWS CLI v2 from
   `awscli.amazonaws.com` and installs it under `/usr/local`, or under
   `AWS_ACCESS_PREFIX` when that is set. A failed install is reported on
   stderr and does not fail the hook. If the environment's network refuses
   the download, add `awscli.amazonaws.com` to its allowed hosts.

It runs on `startup` and `resume`. It needs `bash` and `curl`, and `unzip`
for the install. Only Linux on x86_64 or aarch64 gets the install.

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

A 401 from the hook means the token is wrong, or the network secret's
website is not the endpoint's host.
