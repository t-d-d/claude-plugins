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
git -c advice.detachedHead=false clone -q --depth 1 --branch plugin-sources--v0.2.0 https://github.com/t-d-d/claude-plugins /opt/claude-plugins
mkdir -p "${HOME:-/root}/.claude/skills"
rm -rf "${HOME:-/root}/.claude/skills/plugin-sources"
cp -R /opt/claude-plugins/plugins/plugin-sources "${HOME:-/root}/.claude/skills/plugin-sources"
```

Setup scripts are cached: a new tag reaches an environment when its cache is
rebuilt, which editing the script forces.

## Load it from the repo

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
            "command": "d=\"${XDG_CACHE_HOME:-$HOME/.cache}/plugin-sources/runner/plugin-sources--v0.2.0\"; [ -d \"$d\" ] || git -c advice.detachedHead=false clone -q --depth 1 --branch plugin-sources--v0.2.0 https://github.com/t-d-d/claude-plugins \"$d\" </dev/null; \"$d/plugins/plugin-sources/hooks/plugin-sources.sh\"",
            "timeout": 90
          }
        ]
      }
    ]
  }
}
```

If both are set up, the second run in a session does nothing.

## Where the plugins go

- **In a cloud session**, into `~/.claude/skills/<name>/`. They load in the
  same session, before the first turn. A cloud container belongs to one
  session, so no other repo sees them.
- **Locally**, into the repo's own `.claude/skills/<name>/`, with a
  `.gitignore` of `*` inside each, so git ignores them. They load only in
  sessions on that repo, once you have trusted its folder. A local session
  reads that folder before the hook runs, so when the hook adds, updates or
  removes a plugin it shows a notice asking you to run `/reload-plugins`.
  Later sessions load the plugins at startup and see no notice. Nothing is
  written to `~/.claude/skills/` on your machine.

Each folder plugin-sources makes holds a `.plugin-sources` marker. It replaces
or removes only those folders: a plugin dropped from the list goes on the
next run, and a folder it did not make is never touched. A plugin whose
source has not changed is left as it is. A plugin whose name
is already taken is skipped. If a listed plugin cannot be fetched, its earlier
copy stays.

It needs `git` and `python3`. A fetched plugin's own SessionStart hook does
not run, because the session has already started: a plugin that needs one,
such as [session-logs](../session-logs/README.md), belongs in the setup
script.

## What it did

Apart from the local `/reload-plugins` notice, the hook prints nothing, and it
never stops a session from starting. Each run writes
`$TMPDIR/plugin-sources/report.json`, or `/tmp/...` when `TMPDIR` is unset,
and appends to the `log` beside it: what it delivered, left unchanged,
removed or kept, and every entry it skipped with the reason. Sources it could not reach
are listed under `unreached`.
