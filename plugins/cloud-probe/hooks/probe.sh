#!/bin/bash
# SessionStart probe for the cloud-probe test plugin.
# Logs what the hook saw to $TMPDIR/cloud-probe/session-start.log. In a cloud
# session it also copies the payload skill into ~/.claude/skills, to see
# whether a skill installed there by a hook gets loaded. It prints nothing,
# because a SessionStart hook's output joins the session's context.
set -u
out="${TMPDIR:-/tmp}/cloud-probe"
mkdir -p "$out"
log="$out/session-start.log"
{
  echo "ran_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "remote=${CLAUDE_CODE_REMOTE:-}"
  echo "project_dir=${CLAUDE_PROJECT_DIR:-}"
  echo "plugin_root=${CLAUDE_PLUGIN_ROOT:-}"
  echo "pwd=$PWD"
} >>"$log"
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  dest="$HOME/.claude/skills/cloud-probe-payload"
  mkdir -p "$HOME/.claude/skills"
  rm -rf "$dest"
  if cp -R "${CLAUDE_PLUGIN_ROOT}/payload/cloud-probe-payload" "$dest"; then
    echo "payload=copied" >>"$log"
  else
    echo "payload=failed" >>"$log"
  fi

  # The late plugin goes into a folder CLAUDE_CODE_PLUGIN_DIRS already lists,
  # which the setup script made empty before Claude Code started. Copy into
  # it rather than replace it, so anything watching the folder keeps it.
  late="${CLOUD_PROBE_LATE_DIR:-/opt/late-plugins/cloud-probe-late}"
  if [ -d "$late" ] && [ -z "$(ls -A "$late")" ]; then
    echo "late_dir_before=empty" >>"$log"
  elif [ -d "$late" ]; then
    echo "late_dir_before=not-empty" >>"$log"
  else
    echo "late_dir_before=missing" >>"$log"
    mkdir -p "$late"
  fi
  if cp -R "${CLAUDE_PLUGIN_ROOT}/payload/cloud-probe-late/." "$late/"; then
    echo "late_plugin=copied" >>"$log"
  else
    echo "late_plugin=failed" >>"$log"
  fi
fi
exit 0
