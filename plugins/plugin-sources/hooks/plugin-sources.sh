#!/bin/bash
# SessionStart hook for plugin-sources. The work is in plugin_sources.py.
# A SessionStart hook's output joins the session's context, so the only thing
# that reaches stdout is the hook notice plugin_sources.py prints when a local
# session must run /reload-plugins. It always exits 0, so a failure never
# stops a session starting. What it did is in $TMPDIR/plugin-sources/.
here="$(cd "$(dirname "$0")" && pwd)"
out="$(python3 "$here/plugin_sources.py" 2>/dev/null)"
[ -n "$out" ] && printf '%s\n' "$out"
exit 0
