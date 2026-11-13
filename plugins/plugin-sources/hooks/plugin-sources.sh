#!/bin/bash
# SessionStart hook for plugin-sources. The work is in plugin_sources.py.
# A SessionStart hook's output joins the session's context, so this prints
# nothing, and it always exits 0 so a failure never stops a session starting.
# What it did is in $TMPDIR/plugin-sources/report.json and its log.
here="$(cd "$(dirname "$0")" && pwd)"
python3 "$here/plugin_sources.py" >/dev/null 2>&1
exit 0
