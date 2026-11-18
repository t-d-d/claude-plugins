# plugin-sources

A cloud session does not install the plugins a repo's settings turn on, so a
repo has no built-in way to pull in shared plugins. plugin-sources gives it
one. At session start its hook reads the repo's list, fetches each plugin,
and copies it into a skills folder. Claude Code adopts a plugin folder there
as `<name>@skills-dir`, with its skills, commands and hooks.

## The account, or a list

plugin-sources is for the plugins one repo wants. For plugins you want in
every session, whatever the repo, use your claude.ai account if you have
one.

**On your claude.ai account.** On claude.ai in a browser, open Customize,
then Plugins, add a marketplace such as `t-d-d/claude-plugins`, and install
each plugin. The desktop app's own Plugins page installs on that computer
only.

- Every cloud session you start gets the account's plugins before its first
  turn, on every environment, with no setup script. So does every routine.
- A plugin's settings stay with each environment: its variables and its
  network secrets.
- A session that another session starts with its session tools gets none of
  the account's plugins. That was so on Claude Code 2.1.327.
- The account cannot keep a plugin to some environments. A plugin that
  should work in only some of them needs a setting it does nothing without.
- claude.ai honours a marketplace entry that is pinned to a tag. This
  marketplace pins every plugin, so the account gets a release, not `main`.
  A new release reaches the account when its entry's `ref` has moved and
  claude.ai has synced the marketplace.
- Where a plugin of the same name is also in a skills folder, or installed
  from a marketplace on the machine, Claude Code loads that copy and leaves
  the account's unloaded. So a plugin that is on the account and in a list
  does not run twice.
- Do not install plugin-sources itself on the account. An account's plugin
  loads after the session has read its skills folders, so the plugins it
  delivers do not load in that session.
- A session on your own machine gets the account's plugins too, when Claude
  Code there is signed in with the account. A machine with no such sign-in
  installs a plugin from the marketplace, as each plugin's README shows.

**In a list.** Use plugin-sources where the account does not reach, or does
not fit:

- A repo wants a plugin in its own sessions, for everyone who works on it:
  the repo's list.
- Sessions that other sessions start need a plugin: an environment's own
  list reaches them.
- You have no claude.ai account: an environment's or a machine's own list.

## The repo's list

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

## Load it in a cloud environment

Add this to the environment's setup script on claude.ai. It needs no
variables, and covers every repo the environment serves, including sessions
with several repos.

```bash
rm -rf /opt/claude-plugins
git -c advice.detachedHead=false clone -q --depth 1 --branch plugin-sources--v0.5.0 https://github.com/t-d-d/claude-plugins /opt/claude-plugins
mkdir -p "${HOME:-/root}/.claude/skills"
rm -rf "${HOME:-/root}/.claude/skills/plugin-sources"
cp -R /opt/claude-plugins/plugins/plugin-sources "${HOME:-/root}/.claude/skills/plugin-sources"
```

Setup scripts are cached: a new tag reaches an environment when its cache is
rebuilt, which editing the script forces.

## Load it on your machine

Install it once from the marketplace, and it runs in every local session:

```bash
claude plugin marketplace add t-d-d/claude-plugins
```

```bash
claude plugin install plugin-sources@t-d-d
```

It then reads the list of any repo you open, and the machine's own list
below.

## The environment's or the machine's own list

A cloud environment or a machine can have a list of its own, for plugins
every session on it should have, whatever repo the session works on. Name it
in a variable, `PLUGIN_SOURCES_LIST`:

```
PLUGIN_SOURCES_LIST=owner/name@main:plugin-sources.json
```

- The value names one file to follow, on a branch of a public GitHub repo:
  `owner/name@branch:path`. The address of the file's page,
  `https://github.com/owner/name/blob/main/plugin-sources.json`, works too,
  for a branch with no `/` in its name.
- In a cloud environment, add it to the environment's variables on
  claude.ai. On a machine, set it under `env` in `~/.claude/settings.json`,
  or in your shell's profile:

  ```json
  { "env": { "PLUGIN_SOURCES_LIST": "owner/name@main:plugin-sources.json" } }
  ```

- The file is in the format of a repo's list. The hook fetches it afresh in
  each session, so a commit to it reaches every environment and machine that
  follows it, and no setup script or setting changes.
- Whoever can push to that branch decides what runs in every session there,
  so name a repo you own. The plugins the file lists are still pinned to a
  tag or a commit. It cannot name a further list.

`~/.claude/plugin-sources.json` does the same from a file, and can also hold
`plugins` of its own, as a repo's list does. A cloud environment's setup
script can write it:

```bash
cat > "${HOME:-/root}/.claude/plugin-sources.json" <<'JSON'
{ "list": "owner/name@main:plugin-sources.json", "plugins": [] }
JSON
```

- `list` takes the same value as the variable, or an object:
  `{ "repo": "owner/name", "branch": "main", "path": "plugin-sources.json" }`.
- With both the file and the variable, the hook reads the file's plugins,
  then the file's list, then the variable's.
- If a followed list cannot be fetched, the session starts, and plugins an
  earlier session delivered stay.
- In a cloud session a repo's list is read first, so a repo's plugin comes
  before the environment's of the same name. On a machine it is the other
  way round: see [Where the plugins go](#where-the-plugins-go).
- On a machine, do not also install from the marketplace a plugin the list
  delivers. Claude Code treats the two as separate plugins, each with its own
  hooks.

When a plugin in a followed list is released, move its `ref` there only after
the new tag exists, because sessions read the file from the branch at once.

## Load it from the repo

For single-repo cloud sessions and local sessions, with nothing set up
outside the repo or on the machine, add a SessionStart hook to the repo's
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
            "command": "d=\"${XDG_CACHE_HOME:-$HOME/.cache}/plugin-sources/runner/plugin-sources--v0.5.0\"; [ -d \"$d\" ] || git -c advice.detachedHead=false clone -q --depth 1 --branch plugin-sources--v0.5.0 https://github.com/t-d-d/claude-plugins \"$d\" </dev/null; \"$d/plugins/plugin-sources/hooks/plugin-sources.sh\"",
            "timeout": 90
          }
        ]
      }
    ]
  }
}
```

If it is loaded more than one way, Claude Code starts the hooks together. The
second waits for the first to finish, and then does nothing. When the first
is older than 0.4.0, which did not read the machine's own list, the second
runs after it.

## Where the plugins go

- **In a cloud session**, into `~/.claude/skills/<name>/`. They load in the
  same session, before the first turn. A cloud container belongs to one
  session, so no other repo sees them.
- **Locally, a repo's plugins** go into the repo's own
  `.claude/skills/<name>/`, with a `.gitignore` of `*` inside each, so git
  ignores them. They load only in sessions on that repo, once you have
  trusted its folder. A repo's list never writes to `~/.claude/skills/` on
  your machine.
- **Locally, the machine's own plugins** go into `~/.claude/skills/<name>/`,
  and load in every session on the machine. Claude Code loads that copy over
  a repo's of the same name, so a repo's plugin of that name is not copied.

A local session reads both folders before the hook runs, so when the hook
adds, updates or removes a plugin it shows a notice asking you to run
`/reload-plugins`. Later sessions load the plugins at startup and see no
notice.

Each folder plugin-sources makes holds a `.plugin-sources` marker. It replaces
or removes only those folders: a plugin dropped from the list goes on the
next run, and a folder it did not make is never touched. A plugin whose name
is already taken is skipped. If a listed plugin cannot be fetched, its earlier
copy stays. Two sessions that start together take turns to change a folder.

The marker records the `repo`, `ref` and `path` a folder came from. A plugin
already in place at its listed `ref` is left as it is and is not fetched
again, so a session start with nothing new makes no request for it. A tag
moved at its source is therefore not picked up: list the new tag or commit.

It needs `git` and `python3`.

## A delivered plugin's SessionStart hooks

Claude Code runs them, and plugin-sources does not.

- **In a cloud session** Claude Code loads a delivered plugin once the
  session's SessionStart hooks have finished. It then runs that plugin's own
  SessionStart hooks, before the first turn. This holds whether
  plugin-sources was loaded from the environment's setup script or from the
  repo's settings. It was checked on Claude Code 2.1.327.
- **In a local session** the plugin is not loaded until you run
  `/reload-plugins`. Later sessions load it at startup and run its hooks
  then.

Up to 0.4.1 plugin-sources ran these hooks itself in a cloud session, so each
one ran twice. An older Claude Code that does not run a late plugin's
SessionStart hooks needs 0.4.1.

## What it did

Apart from the local `/reload-plugins` notice, the hook prints nothing, and
it never stops a session from starting. Each run writes
`$TMPDIR/plugin-sources/report.json`, or `/tmp/...` when `TMPDIR` is unset,
and appends to the `log` beside it: what it delivered, left unchanged,
removed or kept, and every entry it skipped with the reason. Sources it could not reach
are listed under `unreached`, and the list it followed under `lists`.
