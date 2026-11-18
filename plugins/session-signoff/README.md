# session-signoff

When a session on your own machine ends its reply with the sign-off line,
session-signoff asks it to archive itself with the desktop app's own tool.

A dispatcher such as [governor](https://github.com/t-d-d/gh-governor)
archives a session whose last reply ends `Signing off.`, and needs nothing in
the repo for that. Two things it cannot do for a session on your machine:

- Its archive does not close the desktop app's window.
- A local session without Remote Control is not on the list it reads, so it
  is never archived at all.

The plugin covers both. It does nothing in a cloud session, where the
dispatcher's archive is enough and the tool is not there to call.

## Install on a machine

```bash
claude plugin marketplace add t-d-d/claude-plugins
claude plugin install session-signoff@t-d-d
```

Then allow the archive tool in `~/.claude/settings.json`. A plugin cannot
pre-approve a tool, and without this the request stops on a permission
prompt:

```json
{
  "permissions": {
    "allow": ["mcp__ccd_session_mgmt__archive_session"]
  }
}
```

The hook needs `bash` and `python3`. Without `python3` it does nothing.

A machine that follows a [plugin-sources](../plugin-sources/README.md) list
can get it from the list instead. Name it there or install it from the
marketplace, not both, and add the permission above either way. A list that
cloud environments also follow can name it too: it does nothing there.

It can come from your claude.ai account instead, with your other plugins: see
[the account, or a list](../plugin-sources/README.md#the-account-or-a-list). A
machine signed in with the account then needs no install of its own. Add the
permission above either way. In the cloud sessions the account reaches, the
plugin does nothing.

## What it does

One blocking Stop hook. It blocks the stop, once, when all of these hold:

- The session is not a cloud session.
- The last non-empty line of the reply starts `Signing off`, followed by
  `.`, `:`, `!` or the end of the line. Bold, italic or code around the line
  is ignored, and a reason may follow a colon:
  `Signing off: the pull request is merged.` This is the rule
  [governor reads a reply by](https://github.com/t-d-d/gh-governor/blob/main/docs/constraints/session-signoff.md).
- No Stop hook has already blocked this stop.

The block asks the session to load `mcp__ccd_session_mgmt__archive_session`
and call it, then to end its reply with `Signing off.` again. A session that
does not have the tool, such as one in the CLI, is asked to say so in one
line and end with `Signing off.` too. Both replies end with the line because
a dispatcher reads the newest reply, and one without it would read as not
signed off.

It writes nothing and makes no request. Any error, a payload it cannot read
included, ends the hook quietly, so it never fails a turn.

## A project with its own copy

The hook started life in one repo's own settings. In a project that still
carries `.claude/hooks/session-signoff.sh`, the plugin does nothing and that
copy does the asking, so one stop is never blocked twice. Remove the
project's copy and the plugin takes over.
