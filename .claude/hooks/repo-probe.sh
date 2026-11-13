#!/bin/bash
# Test-branch probe, never merged. A repo SessionStart hook copies the two
# late plugins from cloud-probe's payload into /opt/repo-late-plugins, which
# only this repo's settings `env` lists in CLAUDE_CODE_PLUGIN_DIRS. The log
# shows what the hook saw; the skill list shows whether the plugins loaded.
set -u
out="${TMPDIR:-/tmp}/cloud-probe"
mkdir -p "$out"
log="$out/repo-start.log"
parent=/opt/repo-late-plugins
src="$CLAUDE_PROJECT_DIR/plugins/cloud-probe/payload"
{
  echo "ran_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "remote=${CLAUDE_CODE_REMOTE:-}"
  echo "plugin_dirs_seen_by_hook=${CLAUDE_CODE_PLUGIN_DIRS:-unset}"
  if [ -d "$parent" ]; then echo "parent_before=exists"; else echo "parent_before=missing"; fi
} >>"$log"
mkdir -p "$parent"
rm -rf "$parent/cloud-probe-late" "$parent/cloud-probe-late-2"
if cp -R "$src/cloud-probe-late" "$parent/cloud-probe-late" && cp -R "$src/cloud-probe-late-2" "$parent/cloud-probe-late-2"; then
  echo "late_plugins=copied" >>"$log"
else
  echo "late_plugins=failed" >>"$log"
fi
exit 0
