#!/bin/bash
# Ship this session's transcript to the session-logs drop box
# (infra/session-logs.cfn.yml) after every turn. Mechanical on purpose (a
# hook, not an instruction), so no session can forget to do it.
#
# Two entry points, both registered in hooks/hooks.json:
#
#   --seed-commit   SessionStart. Records HEAD before the first turn can move
#                   it, for the x-amz-meta-commit header. Stop fires after a
#                   turn, so resolving HEAD there would report a commit the
#                   session made itself.
#   (no argument)   Stop. Does the upload.
#
# Configured entirely by environment, so it runs anywhere (a cloud
# environment, a developer's machine) and uploads nothing where it is not set
# up:
#
#   SESSION_LOG_URL     https://<bucket>.s3.<region>.amazonaws.com/drop/<writer>
#   SESSION_LOG_SECRET  one of the stack's WriterSecrets
#
# The work lives in session-log-export.py next to this file; see there for the
# key layout. This wrapper only decides whether to run at all. It must never
# fail the turn or the session start: every path exits 0.
set -u

if [ -z "${SESSION_LOG_URL:-}" ] || [ -z "${SESSION_LOG_SECRET:-}" ]; then
  exit 0
fi
command -v python3 >/dev/null 2>&1 || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ${1+...}, not a bare "$@": bash before 4.4 (every Mac's /bin/bash)
# treats "$@" as unset under `set -u` when there are no positional
# parameters, and Stop passes none: a bare forward would abort here
# and no transcript would ever ship from a developer's machine.
python3 "$HERE/session-log-export.py" ${1+"$@"} >/dev/null 2>&1
exit 0
