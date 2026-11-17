#!/bin/bash
# Stop hook, blocking. A session on the owner's own machine whose turn ended
# with the sign-off line is asked, by blocking the stop once (exit 2), to
# archive itself. It writes nothing and makes no request: a dispatcher reads
# the sign-off from the session's own reply.
#
# The work lives in session-signoff.py next to this file. This wrapper only
# turns its answer into a Stop hook's. It must never fail the turn: every
# path exits 0, except the one block (exit 2).
set -u

command -v python3 >/dev/null 2>&1 || exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Exit 3 from the module is a Stop block: its stdout is the reason, which
# Claude Code reads from stderr on exit 2. Anything else is a clean exit.
out=$(python3 "$HERE/session-signoff.py" 2>/dev/null)
if [ $? -eq 3 ]; then
  printf '%s\n' "$out" >&2
  exit 2
fi
exit 0
