#!/usr/bin/env python3
"""SessionStart hook for the plugin-sources plugin.

Reads .claude/plugin-sources.json in the session's repo, or in each repo
just below the start folder when a cloud session holds several. Fetches each
public plugin listed there at its pinned commit or tag, and copies it into a
skills folder, where Claude Code adopts it as a <name>@skills-dir plugin:

  - in a cloud session (CLAUDE_CODE_REMOTE=true), ~/.claude/skills;
  - locally, the repo's own .claude/skills, with a .gitignore of "*" in each
    copy, so the plugins load for that repo only and git ignores them.

Every folder it makes holds a .plugin-sources marker. It only ever replaces
or removes folders with that marker, so it never touches anything else in a
skills folder.

It prints nothing; the wrapper discards output and exits 0. What it did goes
to $TMPDIR/plugin-sources/report.json and is appended to the log beside it.
Sources it could not reach are listed as "unreached", for a later broker.

PLUGIN_SOURCES_GIT_BASE replaces https://github.com, for tests.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

LIST = Path('.claude') / 'plugin-sources.json'
OWNED = '.plugin-sources'
PARTIAL = '.plugin-sources-new'
BUDGET_SECONDS = 50  # the hook's timeout is 60
FETCH_SECONDS = 25

REPO_RE = re.compile(r'^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
TAG_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._+/-]*$')
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
RESERVED_NAMES = {'synced'}  # the folder claude.ai's skill sync owns


def utc_now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class Run:
    def __init__(self, state, session, remote):
        self.state = state
        self.deadline = time.monotonic() + BUDGET_SECONDS
        self.work = Path(tempfile.mkdtemp(prefix='work-', dir=state))
        self.fetched = {}
        self.report = {
            'ran_at': utc_now(),
            'session_id': session,
            'mode': 'cloud' if remote else 'local',
            'already_ran': False,
            'targets': [],
            'delivered': [],
            'removed': [],
            'kept': [],
            'skipped': [],
            'unreached': [],
            'errors': [],
        }

    def skip(self, entry, reason):
        self.report['skipped'].append({'entry': entry, 'reason': reason})

    def remaining(self):
        return self.deadline - time.monotonic()


def check_entry(item):
    """Return (entry, None) for a usable list entry, or (None, reason)."""
    if not isinstance(item, dict):
        return None, 'entry is not an object'
    repo, ref, path = item.get('repo'), item.get('ref'), item.get('path')
    if not isinstance(repo, str) or not REPO_RE.match(repo):
        return None, 'repo must be owner/name'
    if not isinstance(ref, str) or not ref:
        return None, 'ref is missing'
    if not SHA_RE.match(ref) and not (
        TAG_RE.match(ref) and '..' not in ref and not ref.endswith(('/', '.lock'))
    ):
        return None, 'ref must be a full commit hash or a tag'
    if not isinstance(path, str) or not path:
        return None, 'path is missing'
    pure = PurePosixPath(path)
    if pure.is_absolute() or '..' in pure.parts:
        return None, 'path must stay inside the repo'
    return {'repo': repo, 'ref': ref, 'path': str(pure)}, None


def read_list(repo_dir, run):
    path = repo_dir / LIST
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        run.report['errors'].append(f'{path}: cannot read plugin-sources.json: {e}')
        return []
    items = data.get('plugins') if isinstance(data, dict) else None
    if not isinstance(items, list):
        run.report['errors'].append(f'{path}: plugin-sources.json has no "plugins" list')
        return []
    entries = []
    for item in items:
        entry, reason = check_entry(item)
        if reason:
            run.skip(item, reason)
        else:
            entries.append(entry)
    return entries


def find_repos(root):
    if (root / LIST).is_file():
        return [root]
    try:
        children = sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.'))
    except OSError:
        return []
    return [p for p in children if (p / LIST).is_file()]


def git(*args, timeout):
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    return subprocess.run(
        ['git', *args], capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL
    )


def fetch(entry, run):
    """Return (checkout, None, None), or (None, reason, unreached)."""
    repo, ref = entry['repo'], entry['ref']
    key = (repo, ref)
    if key in run.fetched:
        return run.fetched[key]
    result = _fetch(repo, ref, run)
    run.fetched[key] = result
    return result


def _fetch(repo, ref, run):
    if run.remaining() < 2:
        return None, f'out of time before fetching {repo}', False
    base = os.environ.get('PLUGIN_SOURCES_GIT_BASE', 'https://github.com').rstrip('/')
    checkout = Path(tempfile.mkdtemp(prefix='src-', dir=run.work))
    is_commit = bool(SHA_RE.match(ref))
    refspec = ref if is_commit else f'refs/tags/{ref}'
    timeout = max(1, min(FETCH_SECONDS, run.remaining() - 1))
    try:
        git('init', '-q', str(checkout), timeout=timeout)
        got = git('-C', str(checkout), 'fetch', '-q', '--depth', '1', '--no-tags', f'{base}/{repo}', refspec, timeout=timeout)
        if got.returncode != 0:
            err = got.stderr.strip()
            if "couldn't find remote ref" in err or 'not our ref' in err:
                if is_commit:
                    return None, f'no commit {ref} in {repo}', False
                return None, f'no tag "{ref}" in {repo} (a branch name is not accepted)', False
            first = err.splitlines()[-1] if err else f'git exited {got.returncode}'
            return None, f'cannot fetch {repo}: {first}', True
        got = git('-C', str(checkout), 'checkout', '-q', '--detach', 'FETCH_HEAD', timeout=timeout)
        if got.returncode != 0:
            return None, f'cannot check out {repo}@{ref}: {got.stderr.strip()}', False
    except subprocess.TimeoutExpired:
        return None, f'cannot fetch {repo}: timed out', True
    return checkout, None, None


def plugin_name(src, entry):
    """Return (name, None) or (None, reason) for the plugin folder src."""
    manifest = src / '.claude-plugin' / 'plugin.json'
    if not manifest.is_file():
        return None, f"no plugin manifest at {entry['path']} in {entry['repo']}@{entry['ref']}"
    try:
        name = json.loads(manifest.read_text()).get('name')
    except (OSError, ValueError, AttributeError):
        name = None
    if not isinstance(name, str) or not NAME_RE.match(name) or name in RESERVED_NAMES:
        return None, f"the manifest at {entry['path']} in {entry['repo']} has no usable name"
    return name, None


def owned(folder):
    return (folder / OWNED).is_file()


def owner_source(folder):
    try:
        data = json.loads((folder / OWNED).read_text())
        return data.get('repo'), data.get('path')
    except (OSError, ValueError, AttributeError):
        return None, None


def deliver(target, entries, local, run):
    run.report['targets'].append(str(target))
    taken = {}
    failed = set()  # (repo, path) listed but not fetched this run: keep any earlier copy
    for entry in entries:
        checkout, reason, unreached = fetch(entry, run)
        if reason:
            run.skip(entry, reason)
            failed.add((entry['repo'], entry['path']))
            if unreached:
                run.report['unreached'].append(entry)
            continue
        src = checkout.joinpath(*PurePosixPath(entry['path']).parts)
        try:
            src.resolve().relative_to(checkout.resolve())  # a symlink must not lead out
        except ValueError:
            run.skip(entry, 'path must stay inside the repo')
            continue
        name, reason = plugin_name(src, entry)
        if reason:
            run.skip(entry, reason)
            continue
        if name in taken:
            run.skip(entry, f'an earlier source already gave a plugin named "{name}"')
            continue
        dest = target / name
        if dest.exists() and not owned(dest):
            run.skip(entry, f'"{name}" is taken by a folder plugin-sources did not make')
            continue
        target.mkdir(parents=True, exist_ok=True)
        partial = target / f'.{name}{PARTIAL}'  # dot-prefixed, so never adopted half-copied
        shutil.rmtree(partial, ignore_errors=True)
        shutil.copytree(src, partial, symlinks=True, ignore=shutil.ignore_patterns('.git'))
        (partial / OWNED).write_text(json.dumps({**entry, 'delivered_at': utc_now()}) + '\n')
        if local:
            (partial / '.gitignore').write_text('*\n')
        if dest.exists():
            shutil.rmtree(dest)
        os.replace(partial, dest)
        taken[name] = entry
        run.report['delivered'].append({'name': name, **entry, 'folder': str(dest)})
    tidy(target, taken, failed, run)


def tidy(target, taken, failed, run):
    if not target.is_dir():
        return
    for child in sorted(target.iterdir()):
        if child.name.startswith('.'):
            if child.name.endswith(PARTIAL):
                shutil.rmtree(child, ignore_errors=True)
            continue
        if not child.is_dir() or not owned(child) or child.name in taken:
            continue
        if owner_source(child) in failed:
            run.report['kept'].append(child.name)
            continue
        shutil.rmtree(child)
        run.report['removed'].append(child.name)


def read_hook_input():
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        data = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def main():
    state = Path(os.environ.get('TMPDIR') or '/tmp') / 'plugin-sources'
    state.mkdir(parents=True, exist_ok=True)
    hook = read_hook_input()
    session = hook.get('session_id') if isinstance(hook.get('session_id'), str) else ''
    remote = os.environ.get('CLAUDE_CODE_REMOTE') == 'true'
    run = Run(state, session, remote)
    marker = state / 'runs' / re.sub(r'[^A-Za-z0-9._-]', '_', session) if session else None
    try:
        if marker and marker.exists():
            run.report['already_ran'] = True
            return
        root = Path(os.environ.get('CLAUDE_PROJECT_DIR') or hook.get('cwd') or os.getcwd())
        repos = find_repos(root)
        if remote:
            # Always tidy the user folder: a reused container may hold plugins
            # an earlier session fetched for a repo that no longer lists them.
            entries = [e for repo in repos for e in read_list(repo, run)]
            groups = [(Path.home() / '.claude' / 'skills', entries)]
        else:
            groups = [(repo / '.claude' / 'skills', read_list(repo, run)) for repo in repos]
            if root not in repos:
                # A repo whose list was deleted still gets its old plugins removed.
                groups.append((root / '.claude' / 'skills', []))
        for target, entries in groups:
            deliver(target, entries, not remote, run)
        if marker:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(utc_now() + '\n')
    except Exception as e:  # never let a failure reach the session
        run.report['errors'].append(f'{type(e).__name__}: {e}')
    finally:
        shutil.rmtree(run.work, ignore_errors=True)
        write_report(state, run.report)


def write_report(state, report):
    (state / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    lines = [f"{report['ran_at']} session={report['session_id'] or '-'} mode={report['mode']}"]
    if report['already_ran']:
        lines.append('  already ran in this session; nothing to do')
    for d in report['delivered']:
        lines.append(f"  delivered {d['name']} from {d['repo']}@{d['ref']}:{d['path']} into {d['folder']}")
    for name in report['removed']:
        lines.append(f'  removed {name}, which the list no longer names')
    for name in report['kept']:
        lines.append(f'  kept the earlier copy of {name}, since its source could not be fetched')
    for s in report['skipped']:
        lines.append(f"  skipped {json.dumps(s['entry'])}: {s['reason']}")
    for e in report['errors']:
        lines.append(f'  error: {e}')
    with open(state / 'log', 'a') as log:
        log.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
