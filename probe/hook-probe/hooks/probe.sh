#!/bin/bash
# Temporary probe. One line per run: when, and which processes started it.
# Prints nothing, so it adds nothing to a session's context.
chain=""
pid=$PPID
for _ in 1 2 3 4; do
  [ -n "$pid" ] && [ "$pid" != 0 ] || break
  chain="$chain <- $(ps -o args= -p "$pid" 2>/dev/null | cut -c1-70)"
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done
echo "$(date -u +%H:%M:%S.%N | cut -c1-12) root=${CLAUDE_PLUGIN_ROOT}$chain" >> "${TMPDIR:-/tmp}/hook-probe.log"
exit 0
