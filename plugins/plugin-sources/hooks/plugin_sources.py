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

A cloud session also reads the environment's own list,
~/.claude/plugin-sources.json, which the environment's setup script writes.
It may name plugins as a repo's list does, and under "list" it may name one
list to follow on a branch of a public repo: {"repo", "branch", "path"}. The
followed list is fetched afresh each session, so a commit to it reaches every
environment that follows it. Its plugins are pinned as any other. A repo's
list is read first, so a repo's plugin comes before the environment's of the
same name.

Claude Code adopts a delivered plugin after the session's SessionStart hooks
have fired, so the plugin's own SessionStart hooks would not run. In a cloud
session this hook runs them, for each plugin it copied in during this run, and
prints what they print, which joins the session's context. A plugin it left
unchanged was in place when the session started, so Claude Code ran its hooks.

A local session scans the repo's .claude/skills before this hook runs, so
when a local run adds, updates or removes a plugin it prints one hook notice,
{"systemMessage": ...}, asking for /reload-plugins. Apart from that notice and
what a delivered plugin's hooks print, it prints nothing. A plugin whose
source has not changed is not copied again. The
wrapper always exits 0. What it did goes to $TMPDIR/plugin-sources/report.json
and is appended to the log beside it.
Sources it could not reach are listed as "unreached", for a later broker.

PLUGIN_SOURCES_GIT_BASE replaces https://github.com, for tests.
"""

import json
import os
import re
import shutil
import signal
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
HOOK_SECONDS = 60  # a command hook's timeout when it names none

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
            'lists': [],
            'delivered': [],
            'unchanged': [],
            'removed': [],
            'kept': [],
            'skipped': [],
            'unreached': [],
            'hooks': [],
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


def check_followed(item):
    """Return (list, None) for a usable "list" value, or (None, reason)."""
    if not isinstance(item, dict):
        return None, 'list must be an object with repo, branch and path'
    repo, branch, path = item.get('repo'), item.get('branch'), item.get('path')
    if not isinstance(repo, str) or not REPO_RE.match(repo):
        return None, 'repo must be owner/name'
    if not isinstance(branch, str) or not branch:
        return None, 'branch is missing'
    if not TAG_RE.match(branch) or '..' in branch or branch.endswith(('/', '.lock')):
        return None, 'branch is not a branch name'
    if not isinstance(path, str) or not path:
        return None, 'path is missing'
    pure = PurePosixPath(path)
    if pure.is_absolute() or '..' in pure.parts:
        return None, 'path must stay inside the repo'
    return {'repo': repo, 'branch': branch, 'path': str(pure)}, None


def load_list(path, run):
    """The parsed list file at path, or None once the error is logged."""
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as e:
        run.report['errors'].append(f'{path}: cannot read plugin-sources.json: {e}')
        return None


def list_entries(data, label, run, required=True):
    """The usable entries under "plugins" in a parsed list."""
    items = data.get('plugins') if isinstance(data, dict) else None
    if items is None and isinstance(data, dict) and not required:
        return []
    if not isinstance(items, list):
        run.report['errors'].append(f'{label}: plugin-sources.json has no "plugins" list')
        return []
    entries = []
    for item in items:
        entry, reason = check_entry(item)
        if reason:
            run.skip(item, reason)
        else:
            entries.append(entry)
    return entries


def read_list(repo_dir, run):
    path = repo_dir / LIST
    data = load_list(path, run)
    return [] if data is None else list_entries(data, path, run)


def environment_entries(run):
    """Return (entries, complete) from the environment's own list.

    The entries are the plugins ~/.claude/plugin-sources.json names, then
    those of the list it follows. complete is False when the file or the
    followed list could not be read: the plugins it would have named are not
    known then, so the caller keeps every earlier copy.
    """
    path = Path.home() / LIST
    if not path.is_file():
        return [], True
    data = load_list(path, run)
    if not isinstance(data, dict):
        if data is not None:
            run.report['errors'].append(f'{path}: plugin-sources.json is not an object')
        return [], False
    entries = list_entries(data, path, run, required='list' not in data)
    if 'list' not in data:
        return entries, True
    followed, reason = check_followed(data['list'])
    if reason:
        run.report['lists'].append({'entry': data['list'], 'fetched': False, 'reason': reason})
        return entries, False
    more, reason = followed_entries(followed, run)
    if reason:
        run.report['lists'].append({**followed, 'fetched': False, 'reason': reason})
        return entries, False
    run.report['lists'].append({**followed, 'fetched': True})
    return entries + more, True


def followed_entries(followed, run):
    """Return (entries, None) from a followed list, or (None, reason)."""
    repo, branch, path = followed['repo'], followed['branch'], followed['path']
    checkout, reason, _ = _fetch(repo, branch, run, branch=True)
    if reason:
        return None, reason
    label = f'{repo}@{branch}:{path}'
    file = checkout.joinpath(*PurePosixPath(path).parts)
    try:
        file.resolve().relative_to(checkout.resolve())  # a symlink must not lead out
    except ValueError:
        return None, 'path must stay inside the repo'
    if not file.is_file():
        return None, f'no file {path} on branch "{branch}" of {repo}'
    try:
        data = json.loads(file.read_text())
    except (OSError, ValueError) as e:
        return None, f'cannot read {label}: {e}'
    if not isinstance(data, dict) or not isinstance(data.get('plugins'), list):
        return None, f'{label} has no "plugins" list'
    # Only "plugins" is read here, so a followed list cannot name a further list.
    return list_entries(data, label, run), None


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


def _fetch(repo, ref, run, branch=False):
    """Fetch a commit or a tag of repo, or with branch=True the head of a branch."""
    if run.remaining() < 2:
        return None, f'out of time before fetching {repo}', False
    base = os.environ.get('PLUGIN_SOURCES_GIT_BASE', 'https://github.com').rstrip('/')
    checkout = Path(tempfile.mkdtemp(prefix='src-', dir=run.work))
    is_commit = not branch and bool(SHA_RE.match(ref))
    refspec = f'refs/heads/{ref}' if branch else ref if is_commit else f'refs/tags/{ref}'
    timeout = max(1, min(FETCH_SECONDS, run.remaining() - 1))
    try:
        git('init', '-q', str(checkout), timeout=timeout)
        got = git('-C', str(checkout), 'fetch', '-q', '--depth', '1', '--no-tags', f'{base}/{repo}', refspec, timeout=timeout)
        if got.returncode != 0:
            err = got.stderr.strip()
            if "couldn't find remote ref" in err or 'not our ref' in err:
                if branch:
                    return None, f'no branch "{ref}" in {repo}', False
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


def owner_entry(folder):
    try:
        data = json.loads((folder / OWNED).read_text())
        return {k: data.get(k) for k in ('repo', 'ref', 'path')}
    except (OSError, ValueError, AttributeError):
        return {}


def owner_source(folder):
    entry = owner_entry(folder)
    return entry.get('repo'), entry.get('path')


def deliver(target, entries, local, run, keep_all=False):
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
        if dest.is_dir() and owner_entry(dest) == entry:
            taken[name] = entry
            run.report['unchanged'].append(name)
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
    tidy(target, taken, failed, run, keep_all)


def tidy(target, taken, failed, run, keep_all=False):
    if not target.is_dir():
        return
    for child in sorted(target.iterdir()):
        if child.name.startswith('.'):
            if child.name.endswith(PARTIAL):
                shutil.rmtree(child, ignore_errors=True)
            continue
        if not child.is_dir() or not owned(child) or child.name in taken:
            continue
        if keep_all or owner_source(child) in failed:
            run.report['kept'].append(child.name)
            continue
        shutil.rmtree(child)
        run.report['removed'].append(child.name)


def session_start_commands(folder, source):
    """The SessionStart command hooks in a plugin's hooks/hooks.json that fit source."""
    try:
        groups = json.loads((folder / 'hooks' / 'hooks.json').read_text())['hooks']['SessionStart']
    except (OSError, ValueError, KeyError, TypeError):
        return []
    found = []
    for group in groups if isinstance(groups, list) else []:
        if not isinstance(group, dict) or not matches(group.get('matcher'), source):
            continue
        hooks = group.get('hooks')
        for hook in hooks if isinstance(hooks, list) else []:
            if isinstance(hook, dict) and hook.get('type') == 'command' and isinstance(hook.get('command'), str):
                found.append(hook)
    return found


def matches(matcher, source):
    if not isinstance(matcher, str) or matcher in ('', '*'):
        return True
    try:
        return re.fullmatch(matcher, source) is not None
    except re.error:
        return matcher == source


def run_start_hooks(run, hook):
    """Run the SessionStart hooks of each plugin delivered in this run.

    Returns what they printed. Each gets the session's hook input on stdin and
    CLAUDE_PLUGIN_ROOT set to its plugin's folder, as from Claude Code. A hook
    that fails or runs out of time is recorded and adds nothing.
    """
    source = hook.get('source') if isinstance(hook.get('source'), str) else 'startup'
    payload = json.dumps(hook)
    shell = shutil.which('bash') or '/bin/sh'
    printed = []
    for delivered in run.report['delivered']:
        folder = Path(delivered['folder'])
        for spec in session_start_commands(folder, source):
            record = {'plugin': delivered['name'], 'command': spec['command']}
            run.report['hooks'].append(record)
            try:
                record['state'], text = run_command(shell, spec, folder, payload, run)
            except Exception as e:  # one plugin's hook must not cost the others
                record['state'], text = f'failed: {type(e).__name__}: {e}', ''
            if text:
                printed.append(text)
    return printed


def run_command(shell, spec, folder, payload, run):
    """Run one command hook. Return (state, text to pass on)."""
    env = {**os.environ, 'CLAUDE_PLUGIN_ROOT': str(folder)}
    background = spec.get('async') is True
    limit = spec.get('timeout')
    limit = limit if isinstance(limit, (int, float)) and not isinstance(limit, bool) and limit > 0 else HOOK_SECONDS
    timeout = min(limit, run.remaining() - 1)
    if not background and timeout < 1:
        return 'out of time', ''
    # A session of its own, so a timeout can stop the command's children too.
    proc = subprocess.Popen(
        [shell, '-c', spec['command']],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL if background else subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env=env,
        start_new_session=True,
    )
    if background:
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
        except OSError:
            pass
        return 'started', ''
    try:
        out, _ = proc.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        return 'timed out', ''
    if proc.returncode != 0:
        return f'exited {proc.returncode}', ''
    text = out.strip()
    try:
        structured = isinstance(json.loads(text), dict)
    except ValueError:
        structured = False
    if structured:
        return 'ran, structured output not used', ''
    return 'ran', text


def reload_notice(report):
    added = [d['name'] for d in report['delivered']]
    parts = []
    if added:
        parts.append('added or updated ' + ', '.join(added))
    if report['removed']:
        parts.append('removed ' + ', '.join(report['removed']))
    if not parts:
        return ''
    return (
        f"plugin-sources {' and '.join(parts)} in this repo's .claude/skills. "
        'Run /reload-plugins to load the change in this session.'
    )


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
            listed = [e for repo in repos for e in read_list(repo, run)]
            more, complete = environment_entries(run)
            entries = []
            for entry in listed + more:
                if entry not in entries:  # the same entry in two lists is one plugin
                    entries.append(entry)
            groups = [(Path.home() / '.claude' / 'skills', entries)]
        else:
            complete = True
            groups = [(repo / '.claude' / 'skills', read_list(repo, run)) for repo in repos]
            if root not in repos:
                # A repo whose list was deleted still gets its old plugins removed.
                groups.append((root / '.claude' / 'skills', []))
        for target, entries in groups:
            deliver(target, entries, not remote, run, keep_all=not complete)
        if marker:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(utc_now() + '\n')
        if remote:
            # A local session has not loaded a delivered plugin until the
            # person reloads, so its hooks are left to the next session.
            printed = run_start_hooks(run, hook)
            if printed:
                print('\n'.join(printed))
        else:
            notice = reload_notice(run.report)
            if notice:
                print(json.dumps({'systemMessage': notice}))
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
    for f in report['lists']:
        name = f"{f['repo']}@{f['branch']}:{f['path']}" if 'repo' in f else json.dumps(f['entry'])
        lines.append(f'  followed the list {name}' if f['fetched'] else f"  could not follow the list {name}: {f['reason']}")
    for d in report['delivered']:
        lines.append(f"  delivered {d['name']} from {d['repo']}@{d['ref']}:{d['path']} into {d['folder']}")
    for name in report['unchanged']:
        lines.append(f'  left {name} as it was, since its source has not changed')
    for name in report['removed']:
        lines.append(f'  removed {name}, which the list no longer names')
    for name in report['kept']:
        lines.append(f'  kept the earlier copy of {name}, since its source or its list could not be fetched')
    for h in report['hooks']:
        lines.append(f"  SessionStart hook of {h['plugin']}: {h.get('state', 'not run')}")
    for s in report['skipped']:
        lines.append(f"  skipped {json.dumps(s['entry'])}: {s['reason']}")
    for e in report['errors']:
        lines.append(f'  error: {e}')
    with open(state / 'log', 'a') as log:
        log.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
