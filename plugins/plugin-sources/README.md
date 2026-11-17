# plugin-sources

A cloud session does not install the plugins a repo's settings turn on, so a
repo has no built-in way to pull in shared plugins. plugin-sources gives it
one. At session start its hook reads the repo's list, fetches each plugin,
and copies it into a skills folder. Claude Code adopts a plugin folder there
as `<name>@skills-dir`, with its skills, commands and hooks.

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
git -c advice.detachedHead=false clone -q --depth 1 --branch plugin-sources--v0.4.0 https://github.com/t-d-d/claude-plugins /opt/claude-plugins
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

[`environment/plugin-sources.json`](../../environment/plugin-sources.json) is
the list this repo's owner follows. Copy it into a repo of your own to start
one. Do not follow it: its owner would then choose what your sessions run.
When a plugin is released, move its `ref` there only after the new tag
exists, because sessions read the file from the branch at once. The tag is
pushed by a workflow when the release merges, so that is a second pull
request, not the same one.

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
            "command": "d=\"${XDG_CACHE_HOME:-$HOME/.cache}/plugin-sources/runner/plugin-sources--v0.4.0\"; [ -d \"$d\" ] || git -c advice.detachedHead=false clone -q --depth 1 --branch plugin-sources--v0.4.0 https://github.com/t-d-d/claude-plugins \"$d\" </dev/null; \"$d/plugins/plugin-sources/hooks/plugin-sources.sh\"",
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
next run, and a folder it did not make is never touched. A plugin whose
source has not changed is left as it is. A plugin whose name
is already taken is skipped. If a listed plugin cannot be fetched, its earlier
copy stays. Two sessions that start together take turns to change a folder.

It needs `git` and `python3`.

## A delivered plugin's SessionStart hooks

Claude Code adopts a delivered plugin after the session's SessionStart hooks
have fired, so the plugin's own would not run. In a cloud session
plugin-sources runs them: the command hooks under `SessionStart` in the
plugin's `hooks/hooks.json`, for each plugin it copied in during this run.

- Each hook gets the session's hook input on stdin and `CLAUDE_PLUGIN_ROOT`
  set to the plugin's folder. A hook with a matcher runs only when the
  matcher fits the session's source.
- What a hook prints joins the session's context. Structured JSON output is
  not used, and hooks of other types are not run.
- A hook runs within its own timeout and within what is left of the 50
  seconds plugin-sources has. One that fails or runs out of time is in the
  report, and the session starts. An `async` hook is started and not waited
  for.
- A plugin left unchanged is not run again. It was in place when the session
  started, so Claude Code ran its hooks.
- A local session runs none of them. It has not loaded the plugin until you
  run `/reload-plugins`, and later sessions load it at startup.

## What it did

Apart from the local `/reload-plugins` notice and what a delivered plugin's
SessionStart hooks print, the hook prints nothing, and it never stops a
session from starting. Each run writes
`$TMPDIR/plugin-sources/report.json`, or `/tmp/...` when `TMPDIR` is unset,
and appends to the `log` beside it: what it delivered, left unchanged,
removed or kept, and every entry it skipped with the reason. Sources it could not reach
are listed under `unreached`, the list it followed under `lists`, and each
SessionStart hook it ran under `hooks`.
