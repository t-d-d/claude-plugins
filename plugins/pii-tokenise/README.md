# pii-tokenise

The model reads a handle, `<email:…:7f3a>`, in place of every personal email
address. The address stays on the machine, in a vault that lasts one session,
and the hook swaps it back in when a tool runs. An operator can paste an
address or read one from a table, and a tool can act on it, and the address
never enters the transcript the model provider keeps.

The plugin narrows what the model sees. It is not an access control: read
[What it does not cover](#what-it-does-not-cover) before relying on it.

## What it does

- **Tool output.** Every address in a tool's output becomes a handle before
  the model reads it. One address has one handle for the session.
- **Tool input.** Every handle in a tool's input becomes its address again
  before the tool runs. Input that another model reads keeps its handles: a
  subagent's prompt, a message to another session, a skill's arguments.
- **A typed prompt.** A prompt carrying an address is blocked, and the block
  message gives the operator the tokenised copy to send instead. With
  [function hooks](#function-hooks) on, the prompt is rewritten on the way in
  and nothing is blocked.
- **A delivered message.** With function hooks on, a message that another
  session or a dispatcher delivers is rewritten before it is queued.
- **A stale handle.** A handle from another session's vault, or from a vault
  since deleted, is refused, and the model is told to read the address again.

An address that names no person passes through: one on a reserved domain
(`example.com`, `.test`, `.invalid`), a `noreply` or `no-reply` sender, a
`*.noreply.github.com` address, and the `git@` of an SSH remote.

An address starts at a letter, a digit or `_`. A `+`, `-` or `.` in front of it
stays outside the handle, so an address at the start of a diff line keeps its
marker and its one handle. A decorator on a diff line, where the marker sits
against the `@`, is left as written.

## Load it

For cloud sessions, install it on your claude.ai account, under Customize,
then Plugins, from this marketplace. Every session you start then has it: see
[the account, or a list](../plugin-sources/README.md#the-account-or-a-list).

Where the account does not reach, name it in a repo's own list or an
environment's, with [plugin-sources](../plugin-sources/README.md):

```json
{ "repo": "t-d-d/claude-plugins", "ref": "pii-tokenise--v0.1.1", "path": "plugins/pii-tokenise" }
```

On a machine, install it from the marketplace:

```bash
claude plugin marketplace add t-d-d/claude-plugins
```

```bash
claude plugin install pii-tokenise@t-d-d
```

It needs `node` on the `PATH`. The tests run on Node 22.

## Function hooks

The prompt and delivery rewrites are Claude Code function hooks, which are in
early access (Claude Code 2.1.280 or later). They load only where the session
runs with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`: set it in the cloud
environment's variables, or under `env` in `~/.claude/settings.json`.

Without it the plugin still tokenises tool output and tool input. A typed
prompt carrying an address is blocked, as above. A delivered message carrying
an address is blocked too, and in an unattended session nobody is there to
send the copy.

## Scripts that take an address

A script cannot tell an address the model typed from one the hook swapped in.
So when a Bash command carries a handle, the hook puts
`export PII_HANDED_OVER=<digest>,…;` in front of the command, with one digest
for each address it swapped in. A digest is the first 32 hex characters of the
address's SHA-256. A script that must take an address only as a handle checks
its argument against that list:

```js
import { createHash } from 'node:crypto';

const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const isHandedOver = (value) => (process.env.PII_HANDED_OVER ?? '').split(',').includes(digest(value));
```

Three things are this plugin's contract with such scripts, and a change to
any of them is a new major version:

- the variable's name, `PII_HANDED_OVER`;
- the digest;
- the handle's form: `<email:`, six hex digits, `:`, four to 64 hex digits,
  `>`. `<email:redacted>` is what the hook writes when it cannot store an
  address, and nothing resolves it.

Do not commit a handle in that full form, in an example or a fixture. No
vault minted it, so the hook refuses every tool input that quotes it. Write
`<email:…:7f3a>` instead.

## A project with its own copy

A repo can register this same script from its own checkout, at
`.claude/hooks/pii-tokenise.mjs`. Where the project has a file at that path,
the plugin does nothing, and the project's copy answers alone. Two copies
keep two vaults, and each would refuse the other's handles as stale.

## The vault

One file for each session, in `pii-vault-<uid>/` under the OS temp directory.
The directory is mode 0700 and the file 0600. The file holds the session's key
and each handle with its address. SessionEnd deletes it, and SessionStart
deletes any vault untouched for a day.

Keep that directory out of anything a session uploads or shares.

## What it does not cover

- **Anything but email addresses.** Names, phone numbers and other
  identifiers pass through.
- **A failed tool call.** Claude Code gives a hook no way to rewrite a
  failure's output.
- **A rewrite that changes a built-in tool's output shape.** Claude Code
  drops it and shows the original. The hook changes only strings, and the
  tests hold each built-in tool's documented shape.
- **A tool that posts to a public system.** The hook swaps the address into
  the input of every tool but the model-read ones above, a comment on a
  public issue included.
- **A session that has not loaded the plugin, and an error inside the hook.**
  The tool runs untouched. Where the vault cannot be opened, the address is
  redacted to `<email:redacted>` instead.
- **A machine with no `node`.** No command hook runs. With function hooks on,
  a delivered message containing `@` is replaced by a notice.

So do not widen an access grant because this plugin is loaded.
