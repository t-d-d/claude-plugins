# common-skills

Skills for every repo:

- `common-skills:unslop` cuts AI tells from prose: PR descriptions, issue
  bodies, docs, commit messages and chat replies.
- `common-skills:pr-description` writes a pull request title and body that a
  reviewer can read in one screen.

## Use it in a repo

List the plugin in the repo's `.claude/plugin-sources.json` and load
[plugin-sources](../plugin-sources/README.md) as its README describes:

```json
{
  "plugins": [
    { "repo": "t-d-d/claude-plugins", "ref": "common-skills--v0.1.0", "path": "plugins/common-skills" }
  ]
}
```

This repo does that for itself: its `.claude/plugin-sources.json` lists
common-skills, and its `.claude/settings.json` holds the plugin-sources repo
hook. A new version of common-skills reaches a repo when its list names the
new tag.

## Credits

`unslop` is a fork of the skill of that name in
[pstack](https://github.com/cursor/plugins/tree/main/pstack), under its own
MIT licence; [its folder](skills/unslop/UPSTREAM.md) has the licence and a
note on what changed.
