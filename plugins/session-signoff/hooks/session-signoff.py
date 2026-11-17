#!/usr/bin/env python3
"""Ask a local session that signed off to archive itself.

Invoked by session-signoff.sh from Stop, blocking. It reads the hook payload
on stdin and does one thing (see ``sign_off``). It writes nothing.

Nothing here may fail the turn. Every error path returns 0 and says nothing.
"""

import json
import os
import re
import sys

# The last line of a reply that signs the session off, read as a person
# writes it: bold, italic or code, a reason after a colon, trailing space.
# It is the rule governor reads a reply by: the line starts "Signing off"
# followed by ".", ":", "!" or the end of the line.
SIGN_OFF = re.compile(r'\ASigning off(?:[.:!]|\Z)')
EMPHASIS = '*_`'

# The exit code that tells the wrapper to block the stop, and why it blocks.
SELF_ARCHIVE = 3
# The reply to it is the turn's newest reply, which a dispatcher reads for
# the sign-off. Both branches end it with the sign-off line, or a session
# without the tool would read as not signed off.
REQUEST = (
    'Signed off. If you have the tool mcp__ccd_session_mgmt__archive_session '
    '(the Claude Code desktop app), load it with ToolSearch and call it now to '
    'archive this session, then end your reply with the line "Signing off.". '
    'If you do not have it, reply with one line saying so, then the line '
    '"Signing off.", and stop.'
)

# A project that registers this hook in its own settings keeps it here.
OWN_COPY = os.path.join('.claude', 'hooks', 'session-signoff.sh')


def signs_off(message):
    """Whether the reply's last non-empty line is the sign-off line."""
    if not isinstance(message, str):
        return False
    lines = [line.strip() for line in message.splitlines() if line.strip()]
    if not lines:
        return False
    return bool(SIGN_OFF.match(lines[-1].strip(EMPHASIS).strip()))


def project_has_own_copy(hook):
    """Whether the session's project carries its own copy of the hook.

    With both loaded, one stop would be blocked twice. The plugin stands down
    there, so it can be installed before such a project drops its copy.
    """
    cwd = hook.get('cwd')
    project = os.environ.get('CLAUDE_PROJECT_DIR') or (cwd if isinstance(cwd, str) and cwd else os.getcwd())
    return os.path.exists(os.path.join(project, OWN_COPY))


def sign_off(hook):
    """Ask a local session that signed off to archive itself.

    A dispatcher decides a session signed off from its own last reply, so
    nothing is recorded here. A local session (the CLI, or the desktop app)
    whose Stop turn signed off returns SELF_ARCHIVE: the wrapper blocks the
    stop with REQUEST, so the model takes one more turn and archives the
    session with the desktop app's own tool, which also closes the app's
    window. A dispatcher's archive cannot, and a local session without Remote
    Control is beyond it altogether. A turn a Stop hook's block continued
    (`stop_hook_active`: this hook's or another's) is never blocked again.
    """
    if hook.get('hook_event_name') != 'Stop':
        return 0
    if os.environ.get('CLAUDE_CODE_REMOTE_SESSION_ID', '') or hook.get('stop_hook_active'):
        return 0
    if not signs_off(hook.get('last_assistant_message')):
        return 0
    if project_has_own_copy(hook):
        return 0
    print(REQUEST)
    return SELF_ARCHIVE


def main():
    try:
        hook = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(hook, dict):
        return 0
    return sign_off(hook)


if __name__ == '__main__':
    sys.exit(main())
