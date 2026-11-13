#!/bin/bash
# UserPromptSubmit marker for the cloud-probe-late test plugin. Each prompt
# appends one line to $TMPDIR/cloud-probe/late-hook.log, so the log shows
# whether this late-loaded plugin's hooks run. It prints nothing, because a
# UserPromptSubmit hook's output joins the prompt's context.
out="${TMPDIR:-/tmp}/cloud-probe"
mkdir -p "$out"
echo "fired_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$out/late-hook.log"
exit 0
