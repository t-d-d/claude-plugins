# session-logs

After every turn, session-logs ships the session's transcript to a
write-only S3 drop box. Installed once on a machine or in a cloud
environment, it ships every repo's sessions. The drop box is a
CloudFormation stack in this repo that anyone can fork and deploy; the
commands below run from the repo root.

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
```

Network secret:

| Field | Value |
|---|---|
| Allowed website | `<bucket>.s3.<region>.amazonaws.com` |
| Header name | `Referer` |
| Prefix | Leave it empty |
| Value | That writer's secret |

The environment's proxy adds the header to each request to the bucket, after
the request has left the session's machine. The session never holds the
secret, so it cannot print it. An environment variable is stored in plain
text and every session in the environment can read it, so leave
`SESSION_LOG_SECRET` unset here.

Setup scripts are cached: a plugin update reaches an environment when its
cache is rebuilt.

With [plugin-sources](../plugin-sources/README.md) 0.3.0 or later in the
environment, the list it follows can name session-logs instead. Then the
setup script above and `CLAUDE_CODE_PLUGIN_DIRS` are not needed. The variable
and the network secret still are.

```json
{ "repo": "t-d-d/claude-plugins", "ref": "session-logs--v0.2.0", "path": "plugins/session-logs" }
```

## Configuration

| Variable | Value |
|---|---|
| `SESSION_LOG_URL` | The stack's `DropUrl` output plus `/<writer>`: `https://<bucket>.s3.<region>.amazonaws.com/drop/<writer>` |
| `SESSION_LOG_SECRET` | One of the stack's writer secrets. Leave it unset where a network secret adds the `Referer` header |

With `SESSION_LOG_URL` unset the plugin does nothing. With only
`SESSION_LOG_SECRET` unset it uploads with no `Referer` header, which the
bucket refuses unless a proxy adds one. Use the regional endpoint: an
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
tokens, and its own writer secret when it holds one. That is a backstop, not a reason to treat
the bucket as clean: only the account, and the reader roles the stack names,
can read it.

## The drop box

[`infra/session-logs.cfn.yml`](../../infra/session-logs.cfn.yml): a private, SSE-encrypted, versioned bucket,
`<BucketPrefix>-<account id>`.

**The secret-referer gate.** Writers need no AWS credentials. The bucket
policy allows anonymous `s3:PutObject` under `drop/` when the request's
`Referer` header equals one of the stack's `WriterSecrets`. One secret per
writer: a machine, a cloud environment. A secret can only add objects under
`drop/`; it cannot read, list, delete, or reach anything else in the account.
Revoke a writer by dropping its secret from the list; rotate by replacing it.
Plain HTTP is denied, since the secret travels as a header.

Raw drops expire after 90 days, and noncurrent versions after 7. Nothing
expires under `digests/`, where a reader writes what it keeps.

**Readers.** Reading the bucket takes credentials in its account, unless the
stack names a reader. `ReaderRoleArns` is an optional comma-separated list of
IAM role ARNs, for roles in other accounts. Each role may list the bucket,
read every object, and write under `digests/`. It cannot write under `drop/`
or delete anything. Plain HTTP is denied to a reader too. With the list empty,
the bucket policy has no reader statement.

For a reader in another account:

- The bucket policy alone is not enough. The role also needs an IAM policy
  in its own account that allows the same actions on the bucket:
  `s3:ListBucket` on the bucket, `s3:GetObject` on its objects, and
  `s3:PutObject` under `digests/`.
- The role must exist when the stack is applied. S3 refuses a policy that
  names a principal it cannot find. Add readers after the first apply has
  succeeded, because a failed first create takes a delete with admin
  credentials.
- IAM stores a principal by internal id, not by name. A role that is deleted
  and recreated loses access, and applying the stack again with the same list
  changes nothing. Apply it once without the role, then once with it.

## Deploying the stack

Fork this repo, or deploy from it directly.

### By the workflow

The `WriterSecrets` parameter is `NoEcho` and a list: `aws cloudformation
deploy` keeps it as it was when an apply omits it, but any change replaces it
whole, so a hand-managed list means retyping every secret on every change.
The **Bootstrap session logs** workflow ([`.github/workflows/session-logs.yml`](../../.github/workflows/session-logs.yml))
builds the list from one GitHub secret per writer instead.

1. **Create a `bootstrap` environment** in the repo's settings, with a
   required reviewer. The deploy role trusts only jobs running there.

2. **Create the GitHub OIDC provider**, if the account has none. Check with
   admin credentials:

   ```bash
   aws iam list-open-id-connect-providers
   ```

   If that lists `token.actions.githubusercontent.com`, skip this step and
   use the ARN it shows. An account holds one provider per URL, so creating a
   second one fails. Otherwise create it from
   [`infra/github-oidc-provider.cfn.yml`](../../infra/github-oidc-provider.cfn.yml):

   ```bash
   aws cloudformation deploy \
     --stack-name github-oidc-provider \
     --template-file infra/github-oidc-provider.cfn.yml
   ```

   It is a stack of its own because every project's deploy role in the
   account trusts the same provider. Its `ProviderArn` output is the
   `OIDCProviderArn` of the next step.

3. **Create the deploy role**, once, with admin credentials:

   ```bash
   aws cloudformation deploy \
     --stack-name session-logs-deploy-role \
     --template-file infra/deploy-role.cfn.yml \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides \
       GitHubRepo=<owner>/<name> \
       GitHubOwnerId=<owner id> \
       GitHubRepoId=<repo id> \
       OIDCProviderArn=arn:aws:iam::<account id>:oidc-provider/token.actions.githubusercontent.com
   ```

   The role's trust matches the subject of GitHub's OIDC token exactly, and
   GitHub issues two forms of it. For a repo created after 15 July 2026 the
   subject carries numeric ids:
   `repo:<owner>@<owner id>/<name>@<repo id>:environment:bootstrap`. Pass
   both ids for such a repo. This prints the owner id, then the repo id:

   ```bash
   gh api repos/<owner>/<name> --jq '.owner.id, .id'
   ```

   Leave both ids out for an older repo, or a fork of one. Its subject is
   `repo:<owner>/<name>:environment:bootstrap`, and the role trusts that form
   when it is given no ids. One id without the other fails the apply. A repo
   or organisation that customised the subject claim needs the condition
   edited to match.

   Pass `StackName` and `BucketPrefix` too if you change them from
   `session-logs`. The role may apply that one stack and configure that one
   bucket: no object access, no `DeleteStack`, no `DeleteBucket`.

4. **Configure the `bootstrap` environment:**

   | Name | Kind | Value |
   |---|---|---|
   | `AWS_DEPLOY_ROLE_ARN` | secret | The deploy-role stack's `RoleArn` output |
   | `SESSION_LOG_WRITER_<NAME>` | secret | One per writer: bare hex, 32+ characters |
   | `SESSION_LOGS_READER_ARNS` | secret | Optional. Comma-separated ARNs of the IAM roles that may read the bucket, with no spaces |
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

   Name the readers, if there are any, in one secret
   (see [The drop box](#the-drop-box)):

   ```bash
   gh secret set SESSION_LOGS_READER_ARNS --env bootstrap \
     --body "arn:aws:iam::<account id>:role/<name>,arn:aws:iam::<account id>:role/<name>"
   ```

   The workflow stops if an entry is not an IAM role ARN. It passes the list
   as `ReaderRoleArns` on every run, empty when the secret is unset.

5. **Dispatch Bootstrap session logs** from the Actions tab. It joins every
   `SESSION_LOG_WRITER_*` value into the parameter, deploys, and prints the
   `DropUrl`. Until `AWS_DEPLOY_ROLE_ARN` is set it stops with a notice.

   The bucket name in the `DropUrl` ends in the account id, and anyone can
   read the run log of a public repo. The workflow masks the id, so the log
   shows `https://<prefix>-***.s3.<region>.amazonaws.com/drop`. Read the real
   URL from the stack, with credentials in the account:

   ```bash
   aws cloudformation describe-stacks --stack-name session-logs \
     --query "Stacks[0].Outputs[?OutputKey=='DropUrl'].OutputValue" --output text
   ```

Add a writer: add a secret, dispatch. Rotate: overwrite it, dispatch, update
that writer's `SESSION_LOG_SECRET`. Remove: delete it, dispatch.

Add or remove a reader: change `SESSION_LOGS_READER_ARNS`, dispatch. Remove
them all: delete the secret, dispatch.

A stack stuck in `UPDATE_ROLLBACK_FAILED` is continued before the deploy
([`scripts/cfn-continue-stalled-rollback.mjs`](../../scripts/cfn-continue-stalled-rollback.mjs)). A failed first create
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

To name readers, add `"ReaderRoleArns=<role ARN>,<role ARN>"`. To remove them
all, pass `"ReaderRoleArns="`, because an apply that leaves a parameter out
keeps its previous value.

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

In a cloud session whose environment holds the network secret, run it without
the header:

```bash
printf 'probe\n' | gzip | curl -sS -f -X PUT -T - \
  "$SESSION_LOG_URL/probe/probe.jsonl.gz" && echo ok
```

A 403 there also means the network secret's website is not the bucket's host,
or its header name is not `Referer`.

