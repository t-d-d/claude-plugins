#!/bin/bash
# Throwaway probe. Appends one line to /tmp/hook-probe.log each time a hook
# runs: the time, the event, the hook input's source, and the command line of
# the process that started it, which tells plugin-sources (python) from
# Claude Code itself. A SessionStart run also prints one line to context.
event="$1"
input="$(cat)"
source="$(printf '%s' "$input" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("source",""))
except Exception: print("")' 2>/dev/null)"
parent="$(tr '\0' ' ' < /proc/$PPID/cmdline 2>/dev/null | cut -c1-120)"
grand="$(tr '\0' ' ' < /proc/$(awk '{print $4}' /proc/$PPID/stat 2>/dev/null)/cmdline 2>/dev/null | cut -c1-120)"
line="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) event=$event source=${source:-none} parent=[$parent] grandparent=[$grand]"
printf '%s\n' "$line" >> /tmp/hook-probe.log
[ "$event" = SessionStart ] && printf 'hook-probe: SessionStart ran at %s\n' "$(date -u +%H:%M:%S.%3N)"
exit 0
