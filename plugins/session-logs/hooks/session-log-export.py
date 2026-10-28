#!/usr/bin/env python3
"""Ship the current session's transcript to the session-logs drop box.

Invoked by session-log-export.sh, which the plugin registers twice
(hooks/hooks.json):

  ``--seed-commit`` runs from SessionStart and does one thing: records HEAD
  before the first turn can move it, for the ``x-amz-meta-commit`` header
  below (see ``seed_commit``).

  No argument runs from Stop, after every turn. It reads the hook payload on
  stdin, and:

    1. finds the transcript (``transcript_path``), the session id, the branch,
       and the session's start date (the first ``timestamp`` in the file);
    2. redacts the secret shapes a transcript is known to carry (a
       ``gh-token:`` prompt prefix, GitHub tokens, AWS keys, Anthropic keys,
       bearer tokens) line by line, so the result is still valid JSONL;
    3. gzips it and PUTs it, anonymously, to

           <SESSION_LOG_URL>/<YYYY-MM-DD>/<session id>.jsonl.gz

       with the writer secret in the Referer header (what the bucket policy
       gates on), and as object metadata the branch, the session's starting
       commit, and the repo, ``<owner>/<name>`` from the ``origin`` remote of
       the payload's ``cwd`` (``x-amz-meta-branch``, ``x-amz-meta-commit``,
       ``x-amz-meta-repo``).

The key is stable for the life of a session: the date is the *start* date,
so every turn, and a resume days later, overwrites the same object. Last
write wins, and the object is always a complete transcript up to that turn.
The hook is async, so a quick turn can finish before the previous turn's
upload has: uploads are serialised per session with a lock, and the
transcript is read only once the lock is held, so the later hook always
ships the newer file and "last write" really is the latest.

Nothing here may fail the turn, or the session start. Every error path returns
0 and says nothing.
Set SESSION_LOG_CURL to substitute the curl binary (tests do).
"""

import datetime
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile

REDACTIONS = [
    # A prompt prefixed `gh-token:<installation token>`: keep the marker,
    # drop the value. Stops at a JSON escape so the rest of the prompt
    # survives.
    (re.compile(r'gh-token:[^\s\\"]+'), 'gh-token:<redacted>'),
    (re.compile(r'\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}'), '<redacted-github-token>'),
    (re.compile(r'sk-ant-[A-Za-z0-9_-]{8,}'), '<redacted-claude-token>'),
    (re.compile(r'\b(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}\b'), '<redacted-aws-key-id>'),
    # Tool output is where this lands, and there it is usually quoted — a
    # shell `export X="…"`, a JSON `{"x": "…"}` — and in the JSONL those
    # quotes arrive escaped. Match the optional quote on either side of the
    # separator so the value itself is what gets replaced.
    (re.compile(r'(aws_secret_access_key(?:\\?")?\s*[=:]\s*(?:\\?")?)[^\s\\"]+', re.IGNORECASE), r'\1<redacted>'),
    (re.compile(r'(Bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*'), r'\1<redacted>'),
]


def redact(text, literals=()):
    """Apply the pattern redactions, then strip any literal the hook knows.

    The writer secret is the one credential the hook is guaranteed to hold,
    and an `env` dump in a tool result would carry it verbatim; shipping it
    would hand the drop box's write credential to whoever reads the drop.
    """
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    for literal in literals:
        if literal and len(literal) >= 8:
            text = text.replace(literal, '<redacted>')
    return text


COMMIT_SHA = re.compile(r'\A[0-9a-f]{7,40}\Z')


def temp_path(template, session):
    """A per-session path in the temp dir; `template` holds one %s.

    Substitute the characters a filename cannot hold rather than deleting
    them: deleting would collapse two session ids that differ only in an
    excluded character onto one path, and the second session would read back
    the first's.
    """
    return os.path.join(tempfile.gettempdir(), template % re.sub(r'[^A-Za-z0-9._-]', '_', session))


def commit_cache(session):
    """Where this session's starting commit is recorded, next to its lock."""
    return temp_path('session-log-head-%s.txt', session)


def resolve_head(cwd):
    """HEAD in cwd, or None outside a repo or without git."""
    try:
        done = subprocess.run(
            ['git', '-C', cwd or '.', 'rev-parse', 'HEAD'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10,
        )
    except Exception:  # noqa: BLE001 — a missing git must not fail the session
        return None
    if done.returncode != 0:
        return None
    head = done.stdout.decode('utf-8', 'replace').strip()
    return head if COMMIT_SHA.match(head) else None


def seed_commit(hook):
    """SessionStart: record HEAD before the first turn gets a chance to move it.

    Which revision of CLAUDE.md and the skills a session actually read is the
    treatment variable for any before-and-after comparison, and no transcript
    record carries a commit. Stop fires *after* a turn, so a HEAD resolved
    there is whatever the session has committed by then — for a
    session that commits, a commit it wrote itself. Only a hook that runs before
    turn 1 can see the revision the session actually read, so this is where the
    value is decided; Stop reads it back and never resolves.

    SessionStart also fires on resume, clear and compaction, each of them after
    HEAD may have moved, so two guards keep those from re-seeding — and both
    are load-bearing. O_EXCL holds while the record survives. The `startup`
    check holds when it does not: the temp dir carries no invalidation and can
    be swept mid-session, and a resume after that would find nothing to collide
    with and record a HEAD the session had moved itself. What it costs is a
    `/clear` that comes back with a fresh session id, which then ships with no
    commit header at all. That is the right way round: no header is a session a
    retro skips, a wrong one is a session it silently miscounts.
    """
    if hook.get('source') != 'startup':
        return 0
    session = hook.get('session_id')
    if not isinstance(session, str) or not session:
        return 0  # the payload is someone else's JSON: a wrong type costs the header
    head = resolve_head(hook.get('cwd'))
    if not head:
        return 0  # outside a repo there is nothing to record
    try:
        fd = os.open(commit_cache(session), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        return 0  # already seeded, or an unwritable temp dir: keep what is there
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(head)
    except OSError:
        pass  # a truncated cache reads back as no commit, which is the safe answer
    return 0


def session_start_commit(session):
    """The commit seeded at session start, or None if none was.

    Read-only on purpose. Falling back to resolving HEAD here would report the
    end of the turn rather than the start of the session, which is the whole
    bug; a cache that was never written, or was swept from the temp dir
    mid-session, costs the header instead of reporting a wrong commit.
    """
    try:
        with open(commit_cache(session)) as handle:
            cached = handle.read().strip()
    except Exception:  # noqa: BLE001 — an unreadable cache costs a header, not the upload
        return None
    return cached if COMMIT_SHA.match(cached) else None


# An origin remote, as a URL with a scheme or in scp form (user@host:path);
# a bare filesystem path names no hosted repo. The path's last two segments
# are the repo, which also reads a cloud session's local git proxy
# (http://proxy@127.0.0.1:<port>/git/<owner>/<name>).
REMOTE_URL = re.compile(r'\A(?:[a-z][a-z0-9+.-]*://[^/]+/|[^/@:\s]+@[^/:\s]+:)(?P<path>.+)\Z', re.IGNORECASE)
REPO_SLUG = re.compile(r'\A[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z')


def repo_slug(origin):
    """``<owner>/<name>`` from an origin URL, or None for one that names neither."""
    match = REMOTE_URL.match(origin.strip())
    if not match:
        return None
    path = match.group('path').strip('/')
    if path.endswith('.git'):
        path = path[:-4]
    slug = '/'.join(path.split('/')[-2:])
    return slug if REPO_SLUG.match(slug) else None


def resolve_repo(cwd):
    """The repo the origin remote of cwd names, or None."""
    try:
        done = subprocess.run(
            ['git', '-C', cwd or '.', 'remote', 'get-url', 'origin'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10,
        )
    except Exception:  # noqa: BLE001 — a missing git costs the header, not the upload
        return None
    if done.returncode != 0:
        return None
    return repo_slug(done.stdout.decode('utf-8', 'replace'))


def acquire_lock(session):
    """Serialise uploads per session; None where the platform has no flock."""
    try:
        import fcntl
    except ImportError:
        return None
    try:
        handle = open(temp_path('session-log-export-%s.lock', session), 'w')
        fcntl.flock(handle, fcntl.LOCK_EX)
    except OSError:
        return None
    return handle


def scan(raw):
    """First timestamp's UTC date and the last branch seen, from the JSONL."""
    date = None
    branch = None
    for line in raw.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        stamp = record.get('timestamp')
        if date is None and isinstance(stamp, str) and len(stamp) >= 10:
            date = stamp[:10]
        seen = record.get('gitBranch')
        if isinstance(seen, str) and seen:
            branch = seen
    return date, branch


def put(curl, url, secret, path, headers, max_time):
    """PUT the file at `path` to `url` under the writer secret. Never raises."""
    args = [curl, '-sS', '-f', '-o', '/dev/null', '--max-time', str(max_time), '-X', 'PUT', '-T', path, '-H', 'Referer: %s' % secret]
    for header in headers:
        args += ['-H', header]
    args.append(url)
    try:
        subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=max_time + 5)
    except Exception:  # noqa: BLE001 — the hook must never fail the turn
        pass


def main():
    try:
        hook = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(hook, dict):
        return 0
    if '--seed-commit' in sys.argv[1:]:
        return seed_commit(hook)

    # Read as options, not required keys: the module contract is "every error
    # path returns 0 and says nothing", so a missing var is a silent no-op here
    # too rather than an uncaught KeyError. The .sh wrapper guards both.
    url = os.environ.get('SESSION_LOG_URL')
    secret = os.environ.get('SESSION_LOG_SECRET')
    url = url.rstrip('/') if url and secret else None
    curl = os.environ.get('SESSION_LOG_CURL', 'curl')
    if url is None:
        return 0
    path = hook.get('transcript_path')
    session = hook.get('session_id')
    if not path or not session or not os.path.isfile(path):
        return 0

    lock = acquire_lock(session)
    body = tempfile.NamedTemporaryFile(prefix='session-log-', suffix='.jsonl.gz', delete=False)
    body.close()
    try:
        # Read under the lock: if an earlier turn's upload is still running,
        # this waits for it and then ships the file as it is *now*.
        with open(path, 'rb') as handle:
            raw = handle.read().decode('utf-8', 'replace')
        date, branch = scan(raw)
        if date is None:
            date = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        with gzip.open(body.name, 'wb') as out:
            out.write(redact(raw, (secret,)).encode('utf-8'))
        headers = ['Content-Type: application/gzip']
        if branch:
            headers.append('x-amz-meta-branch: %s' % branch)
        commit = session_start_commit(session)
        if commit:
            headers.append('x-amz-meta-commit: %s' % commit)
        repo = resolve_repo(hook.get('cwd'))
        if repo:
            headers.append('x-amz-meta-repo: %s' % repo)
        put(curl, '%s/%s/%s.jsonl.gz' % (url, date, session), secret, body.name, headers, 50)
    except Exception:  # noqa: BLE001 — the hook must never fail the turn
        pass
    finally:
        try:
            os.unlink(body.name)
        except OSError:
            pass
        if lock is not None:
            lock.close()  # closing the handle releases the flock
    return 0


if __name__ == '__main__':
    sys.exit(main())
