# claude-plugins

A Claude Code plugin marketplace, `t-d-d`. It holds two plugins:

- **session-logs**: after every turn, ships the session's transcript to a
  write-only S3 drop box. Installed once on a machine or in a cloud
  environment, it ships every repo's sessions. The drop box is a
  CloudFormation stack in this repo that anyone can fork and deploy.
- **plugin-sources**: at session start, loads the public plugins a repo
  lists in `.claude/plugin-sources.json`, pinned to a commit or a tag, in
  cloud and local sessions. See [plugin-sources](#plugin-sources).

The sections from here to [Development](#development) cover session-logs.

## Install on a machine

```bash
claude plugin marketplace add t-d-d/claude-plugins
claude plugin install session-logs@t-d-d
```

Then set the two variables in `~/.claude/settings.json`, which the desktop
app reads too (it reads no shell profile):

```json
{
  "env": {
    "SESSION_LOG_URL": "https://<bucket>.s3.<region>.amazonaws.com/drop/<writer>",
    "SESSION_LOG_SECRET": "<that writer's secret>"
  }
}
```

## Install in a cloud environment

A cloud session does not install the plugins a repo's settings enable, and a
session cannot set the variable that loads one, so both go in the
environment's settings on claude.ai.

Setup script:

```bash
if [ -d /opt/claude-plugins/.git ]; then
  git -C /opt/claude-plugins pull -q --ff-only
else
  git clone -q --depth 1 https://github.com/t-d-d/claude-plugins /opt/claude-plugins
fi
```

Environment variables:

```
CLAUDE_CODE_PLUGIN_DIRS=/opt/claude-plugins/plugins/session-logs
SESSION_LOG_URL=https://<bucket>.s3.<region>.amazonaws.com/drop/<writer>
SESSION_LOG_SECRET=<that writer's secret>
```

Setup scripts are cached: a plugin update reaches an environment when its
cache is rebuilt.

## Configuration

| Variable | Value |
|---|---|
| `SESSION_LOG_URL` | The stack's `DropUrl` output plus `/<writer>`: `https://<bucket>.s3.<region>.amazonaws.com/drop/<writer>` |
| `SESSION_LOG_SECRET` | One of the stack's writer secrets |

With either unset the plugin does nothing. Use the regional endpoint: an
anonymous PUT to the global one may be answered with a redirect the hook does
not follow. The hooks need `bash`, `python3`, `curl` and, for the commit and
repo headers, `git`.

## What a session uploads

**Key layout.** `drop/<writer>/<YYYY-MM-DD>/<session id>.jsonl.gz`. The date
is the session's *start* date (the first timestamp in the transcript), so the
key is stable across turns, midnight, and a resume days later. Each turn
overwrites the same object with the whole transcript up to that turn; the
bucket is versioned, so an overwrite can be rolled back. Listing
`drop/<writer>/2026-09-` lists a month.

**Metadata headers.**

| Header | Value |
|---|---|
| `x-amz-meta-branch` | The last `gitBranch` in the transcript |
| `x-amz-meta-commit` | HEAD when the session *started* |
| `x-amz-meta-repo` | `<owner>/<name>`, from the `origin` remote of the session's working directory |

The commit is recorded by a SessionStart hook before the first turn runs; the
Stop hook only reads it back. Stop fires after a turn, so resolving HEAD there
would report whatever the session had committed by then. Resume, clear and
compaction never overwrite the record, and a session whose record is missing
ships with no commit header rather than a wrong one. It says which revision of
`CLAUDE.md` and the skills a session ran under.

The repo header is parsed from https, ssh and scp-form remotes, with `.git`
stripped. A checkout with no origin, or a session outside a repo, ships
without it. Read it back with `aws s3api head-object`.

**Redaction.** Before upload the hook redacts GitHub tokens, a `gh-token:`
prompt prefix, AWS key ids and secret keys, Anthropic `sk-ant-` keys, bearer
tokens, and its own writer secret. That is a backstop, not a reason to treat
the bucket as clean: no one outside the account can read it.

## The drop box

`infra/session-logs.cfn.yml`: a private, SSE-encrypted, versioned bucket,
`<BucketPrefix>-<account id>`.

**The secret-referer gate.** Writers need no AWS credentials. The bucket
policy allows anonymous `s3:PutObject` under `drop/` when the request's
`Referer` header equals one of the stack's `WriterSecrets`. One secret per
writer: a machine, a cloud environment. A secret can only add objects under
`drop/`; it cannot read, list, delete, or reach anything else in the account.
Revoke a writer by dropping its secret from the list; rotate by replacing it.
Plain HTTP is denied, since the secret travels as a header.

Raw drops expire after 90 days, and noncurrent versions after 7. Nothing
expires under `digests/`, where a reader writes what it keeps. Reading the
bucket takes credentials in the account; the stack grants no reader.

## Deploying the stack

Fork this repo, or deploy from it directly.

### By the workflow

The `WriterSecrets` parameter is `NoEcho` and a list: `aws cloudformation
deploy` keeps it as it was when an apply omits it, but any change replaces it
whole, so a hand-managed list means retyping every secret on every change.
The **Bootstrap session logs** workflow (`.github/workflows/session-logs.yml`)
builds the list from one GitHub secret per writer instead.

1. **Create a `bootstrap` environment** in the repo's settings, with a
   required reviewer. The deploy role trusts only jobs running there.

2. **Create the deploy role**, once, with admin credentials:

   ```bash
   aws cloudformation deploy \
     --stack-name session-logs-deploy-role \
     --template-file infra/deploy-role.cfn.yml \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       GitHubRepo=<owner>/<name> \
       OIDCProviderArn=arn:aws:iam::<account id>:oidc-provider/token.actions.githubusercontent.com
   ```

   It takes the account's existing GitHub OIDC provider (an account holds one
   per URL); create one first if the account has none. Pass `StackName` and
   `BucketPrefix` too if you change them from `session-logs`. The role may
   apply that one stack and configure that one bucket: no object access, no
   `DeleteStack`, no `DeleteBucket`.
   Its trust expects GitHub's default subject claim,
   `repo:<owner>/<name>:environment:bootstrap`; a repo or organisation that
   customised the claim needs the condition edited to match.

3. **Configure the `bootstrap` environment:**

   | Name | Kind | Value |
   |---|---|---|
   | `AWS_DEPLOY_ROLE_ARN` | secret | The deploy-role stack's `RoleArn` output |
   | `SESSION_LOG_WRITER_<NAME>` | secret | One per writer: bare hex, 32+ characters |
   | `SESSION_LOGS_STACK` | variable | Stack name; default `session-logs` |
   | `SESSION_LOGS_BUCKET_PREFIX` | variable | Bucket prefix; default `session-logs` |
   | `AWS_REGION` | variable | Region writers PUT to; default `us-east-1` |

   Generate a writer secret with:

   ```bash
   # Command substitution drops the trailing newline, which the workflow rejects.
   TOKEN=$(openssl rand -hex 24)
   gh secret set SESSION_LOG_WRITER_<NAME> --env bootstrap --body "$TOKEN"
   echo "$TOKEN"   # the same value is that writer's SESSION_LOG_SECRET
   ```

   If a repository secret of the same name exists, delete it: an environment
   secret shadows it while both exist, so deleting only the environment copy
   would let the repository value back into the list.

4. **Dispatch Bootstrap session logs** from the Actions tab. It joins every
   `SESSION_LOG_WRITER_*` value into the parameter, deploys, and prints the
   `DropUrl`. Until `AWS_DEPLOY_ROLE_ARN` is set it stops with a notice.

Add a writer: add a secret, dispatch. Rotate: overwrite it, dispatch, update
that writer's `SESSION_LOG_SECRET`. Remove: delete it, dispatch.

A stack stuck in `UPDATE_ROLLBACK_FAILED` is continued before the deploy
(`scripts/cfn-continue-stalled-rollback.mjs`). A failed first create
(`ROLLBACK_COMPLETE`) takes a delete with admin credentials.

### By hand

```bash
# The FULL list, on any change to it. Keep it out of shell history (a
# leading space under HISTCONTROL=ignorespace, or read the list from a file).
aws cloudformation deploy \
  --stack-name session-logs \
  --template-file infra/session-logs.cfn.yml \
  --parameter-overrides "WriterSecrets=<secret>,<secret>" "BucketPrefix=session-logs"
```

An existing stack keeps its bucket by passing the prefix it was created with:
the logical ids (`SessionLogsBucket`, `SessionLogsBucketPolicy`) do not change,
so the apply updates both in place.

### Verify

From a shell with the two variables set:

```bash
printf 'probe\n' | gzip | curl -sS -f -X PUT -T - \
  -H "Referer: $SESSION_LOG_SECRET" \
  "$SESSION_LOG_URL/probe/probe.jsonl.gz" && echo ok
```

A 403 means the secret is not in the deployed list, or the URL is not under
`drop/`.

## plugin-sources

A cloud session does not install the plugins a repo's settings turn on, so a
repo has no built-in way to pull in shared plugins. plugin-sources gives it
one. At session start its hook reads the repo's list, fetches each plugin,
and copies it into a skills folder. Claude Code adopts a plugin folder there
as `<name>@skills-dir`, with its skills, commands and hooks.

### The repo's list

`.claude/plugin-sources.json`:

```json
{
  "plugins": [
    { "repo": "owner/name", "ref": "v1.2.0", "path": "plugins/example" }
  ]
}
```

- `repo` is a public GitHub repo, and `path` is the plugin's folder in it,
  holding `.claude-plugin/plugin.json`.
- `ref` is a full commit hash or a tag. A tag is fetched as
  `refs/tags/<ref>`, so a branch name is refused, and a source's owner
  cannot change what your sessions run.

### Load it in a cloud environment

Add this to the environment's setup script on claude.ai. It needs no
variables, and covers every repo the environment serves, including sessions
with several repos.

```bash
rm -rf /opt/claude-plugins
git -c advice.detachedHead=false clone -q --depth 1 --branch plugin-sources--v0.1.0 https://github.com/t-d-d/claude-plugins /opt/claude-plugins
mkdir -p "${HOME:-/root}/.claude/skills"
rm -rf "${HOME:-/root}/.claude/skills/plugin-sources"
cp -R /opt/claude-plugins/plugins/plugin-sources "${HOME:-/root}/.claude/skills/plugin-sources"
```

Setup scripts are cached: a new tag reaches an environment when its cache is
rebuilt, which editing the script forces.

### Load it from the repo

For single-repo cloud sessions and local sessions, with nothing set up
outside the repo, add a SessionStart hook to the repo's
`.claude/settings.json`. It clones this repo at a tag into a cache once, then
runs the same script:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "d=\"${XDG_CACHE_HOME:-$HOME/.cache}/plugin-sources/runner/plugin-sources--v0.1.0\"; [ -d \"$d\" ] || git -c advice.detachedHead=false clone -q --depth 1 --branch plugin-sources--v0.1.0 https://github.com/t-d-d/claude-plugins \"$d\" </dev/null; \"$d/plugins/plugin-sources/hooks/plugin-sources.sh\"",
            "timeout": 90
          }
        ]
      }
    ]
  }
}
```

If both are set up, the second run in a session does nothing.

### Where the plugins go

- **In a cloud session**, into `~/.claude/skills/<name>/`. They load in the
  same session, before the first turn. A cloud container belongs to one
  session, so no other repo sees them.
- **Locally**, into the repo's own `.claude/skills/<name>/`, with a
  `.gitignore` of `*` inside each, so git ignores them. They load only in
  sessions on that repo, once you have trusted its folder. The first session
  that fetches them may need `/reload-plugins`; later sessions load them at
  startup. Nothing is written to `~/.claude/skills/` on your machine.

Each folder plugin-sources makes holds a `.plugin-sources` marker. It replaces
or removes only those folders: a plugin dropped from the list goes on the
next run, and a folder it did not make is never touched. A plugin whose name
is already taken is skipped. If a listed plugin cannot be fetched, its earlier
copy stays.

It needs `git` and `python3`. A fetched plugin's own SessionStart hook does
not run, because the session has already started: a plugin that needs one,
such as session-logs, belongs in the setup script.

### What it did

The hook prints nothing and never stops a session from starting. Each run
writes `$TMPDIR/plugin-sources/report.json`, or `/tmp/...` when `TMPDIR` is
unset, and appends to the `log` beside it: what it delivered, removed or
kept, and every entry it skipped with the reason. Sources it could not reach
are listed under `unreached`.

## Development

`npm ci && npm test`. Node 22 or later and `python3`. See `CLAUDE.md`.
