#!/usr/bin/env python3
"""Keep docs/upstream-sync.json, the ledger of what the rewrite has taken from upstream, current.

  scripts/upstream_sync.py update [--no-fetch]   fetch upstream, append every commit after the ledger's base that it
                                                 does not list as `pending` (however many runs were missed), render,
                                                 list. `--fetch` is accepted; fetching is the default.
  scripts/upstream_sync.py list                  the work list (pending and deferred entries) with how to take each;
                                                 reads only
  scripts/upstream_sync.py resolve               fill `rewriteCommits` of ported entries from `Upstream:` trailers
  scripts/upstream_sync.py render [--check]      write (or compare) docs/upstream-sync.md
  scripts/upstream_sync.py check [--fetch] [--max-pending-days N]
                                                 exit 1 on an invalid ledger, a stale table or pending work older
                                                 than N days; with --fetch, unlisted upstream commits count as pending

Reads the public upstream anonymously and never writes to it: every git call goes through git() below, which runs
only the read-only subcommands in GIT_ALLOWED plus `fetch`, with credentials and prompts turned off. The fetch goes
into refs/upstream-sync/*, so no branch, remote-tracking ref or working tree changes. Standard library only.

The procedure for taking one entry from `pending` to `ported` is docs/upstream-sync-procedure.md.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LEDGER = 'docs/upstream-sync.json'
TABLE = 'docs/upstream-sync.md'
PLUGIN = 'Jellyfin.Plugin.JellyfinEnhanced/'
REF_BRANCH = 'refs/upstream-sync/{branch}'
REF_TAGS = 'refs/upstream-sync/tags/'

CLASSES = {
    'feature': 'user-facing feature',
    'fix': 'bug fix',
    'performance': 'performance',
    'security': 'security',
    'translation': 'translation or locale data',
    'docs': 'documentation',
    'test': 'tests only (ported with the change they pin)',
    'ci': 'CI or repository housekeeping',
    'release': 'release bookkeeping (version, manifest)',
    'deps': 'dependency update',
    'unclassified': 'could not be guessed; classify it by hand',
}
# status -> the free-text fields an entry in that status must carry
STATUSES = {
    'pending': (),
    'ported': (),
    'already-present': ('evidence',),
    'not-applicable': ('reason',),
    'deferred': ('reason', 'needs'),
}
OPEN = ('pending', 'deferred')
# How an entry of each class is usually taken (docs/upstream-sync-procedure.md has the rules). `{sha}` is filled in.
HOW = {
    'feature': 're-implement in the owning feature; upstream\'s tests first; lab parity',
    'fix': 're-implement in the owning feature; a test that fails first; lab parity if a user can see it',
    'performance': 're-implement; keep upstream\'s measurement or test',
    'security': 're-implement; a test that fails first; never weaken a check',
    'translation': 'applies as is: git show {sha} | git apply --3way',
    'docs': 'applies as is where the page exists: git show {sha} | git apply --3way',
    'ci': 'applies as is to the workflows this tree has: git show {sha} | git apply --3way',
    'deps': 'applies as is; give this tree\'s own files the same pins: git show {sha} | git apply --3way',
    'release': 'one chore(release) commit, last: the version in JellyfinEnhanced.csproj and manifest.json from upstream',
    'test': 'port with the change it pins: set "with" to that entry\'s sha',
    'unclassified': 'read git show {sha}, then set its class',
}

# Every git subcommand this script may run. Nothing here writes to a remote; `fetch` only reads one.
GIT_ALLOWED = frozenset({'cat-file', 'diff-tree', 'fetch', 'for-each-ref', 'log', 'ls-files', 'merge-base', 'rev-list',
                         'rev-parse', 'show'})
FETCH_SCHEMES = ('https://', 'git://', 'file://', '/')


class SyncError(Exception):
    """A problem the caller can fix; printed without a traceback."""


def run_git(repo, *args):
    """Run one allow-listed git subcommand without credentials, prompts or hooks. Returns (exit code, stdout, stderr)."""
    if not args or args[0] not in GIT_ALLOWED:
        raise SyncError(f"upstream_sync never runs `git {args[0] if args else ''}` (allowed: {', '.join(sorted(GIT_ALLOWED))})")
    env = {key: value for key, value in os.environ.items()
           if key not in ('GIT_ASKPASS', 'SSH_ASKPASS', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1', LC_ALL='C')
    command = ['git', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never',
               '-c', 'core.quotePath=false', '-C', str(repo), *args]
    result = subprocess.run(command, capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    return result.returncode, result.stdout, result.stderr


def git(repo, *args, check=True):
    """stdout of one allow-listed git subcommand; a failure raises unless check is False."""
    code, out, err = run_git(repo, *args)
    if check and code != 0:
        raise SyncError(f"git {' '.join(args)} failed ({code}): {err.strip()}")
    return out


def is_ancestor(repo, ancestor, descendant):
    return run_git(repo, 'merge-base', '--is-ancestor', ancestor, descendant)[0] == 0


def fetch(repo, url, branch):
    """Fetch the upstream branch and its tags into refs/upstream-sync/* and return the branch ref."""
    if not url.startswith(FETCH_SCHEMES):
        raise SyncError(f'upstream.url must be an anonymous https://, git:// or local path, not {url!r}')
    ref = REF_BRANCH.format(branch=branch)
    git(repo, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', url,
        f'+refs/heads/{branch}:{ref}', f'+refs/tags/*:{REF_TAGS}*')
    return ref


def ref_exists(repo, ref):
    return git(repo, 'rev-parse', '--verify', '--quiet', ref + '^{commit}', check=False).strip() != ''


def load_ledger(path):
    try:
        ledger = json.loads(Path(path).read_text())
    except FileNotFoundError:
        raise SyncError(f'{path} does not exist') from None
    except json.JSONDecodeError as error:
        raise SyncError(f'{path} is not valid JSON: {error}') from None
    return ledger


def save_ledger(path, ledger):
    Path(path).write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + '\n')


# ---------------------------------------------------------------------------------------------- reading upstream

def upstream_commits(repo, base, tip):
    """Full SHAs after `base` up to `tip`, oldest first, first parents only (a merged pull request is one entry)."""
    if not is_ancestor(repo, base, tip):
        raise SyncError(f'the ledger base {base[:10]} is not an ancestor of upstream {tip}: upstream history was rewritten, '
                        'or the ledger names another repository')
    return git(repo, 'rev-list', '--reverse', '--first-parent', f'{base}..{tip}').split()


def release_tags(repo, base, tip):
    """[(tag, sha)] of the upstream release tags inside base..tip, oldest first."""
    tags = []
    out = git(repo, 'for-each-ref', '--format=%(refname) %(objectname) %(*objectname)', REF_TAGS, 'refs/tags/')
    seen = set()
    for line in out.splitlines():
        parts = line.split()
        name = parts[0].replace(REF_TAGS, '', 1).replace('refs/tags/', '', 1)
        sha = parts[2] if len(parts) > 2 else parts[1]
        if name in seen:
            continue
        if is_ancestor(repo, sha, tip) and not is_ancestor(repo, sha, base):
            seen.add(name)
            tags.append((name, sha))
    order = {sha: index for index, sha in enumerate(git(repo, 'rev-list', '--reverse', f'{base}..{tip}').split())}
    return sorted(tags, key=lambda tag: order.get(tag[1], 0))


def describe(repo, sha):
    """One upstream commit as the facts a ledger entry records."""
    head = git(repo, 'show', '-s', '--format=%H%x00%cI%x00%an%x00%s%x00%b', sha).rstrip('\n').split('\x00')
    full, date, author, subject, body = head[0], head[1], head[2], head[3], head[4] if len(head) > 4 else ''
    files, insertions, deletions = [], 0, 0
    for line in git(repo, 'diff-tree', '--no-commit-id', '--numstat', '-r', '-m', '--first-parent', '--root', sha).splitlines():
        added, removed, path = line.split('\t', 2)
        files.append(path)
        insertions += int(added) if added.isdigit() else 0
        deletions += int(removed) if removed.isdigit() else 0
    return {'sha': full, 'date': date, 'author': author, 'subject': subject, 'body': body, 'files': files,
            'insertions': insertions, 'deletions': deletions}


# ---------------------------------------------------------------------------------------------------- guessing

VERSION_SUBJECT = re.compile(r'^v?\d+\.\d+\.\d+(\.\d+)?\b')
PREFIX = re.compile(r'^(\w+)(\([^)]*\))*!?:')
PREFIX_CLASS = {'feat': 'feature', 'feature': 'feature', 'fix': 'fix', 'bugfix': 'fix', 'hotfix': 'fix', 'revert': 'fix',
                'perf': 'performance', 'security': 'security', 'sec': 'security', 'docs': 'docs', 'doc': 'docs',
                'test': 'test', 'tests': 'test', 'ci': 'ci', 'build': 'ci', 'chore': 'ci', 'style': 'ci',
                'refactor': 'ci', 'i18n': 'translation', 'l10n': 'translation', 'release': 'release'}
VERSION_FILES = ('manifest.json', PLUGIN + 'JellyfinEnhanced.csproj')


def is_locale(path):
    return path.startswith(PLUGIN + 'js/locales/')


def is_docs(path):
    return path.startswith('docs/') or path in ('mkdocs.yml', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md') or path.startswith('overrides/')


def is_test(path):
    return path.startswith('tests/')


def is_ci(path):
    return path.startswith('.github/') or path in ('.gitignore', '.gitattributes', '.pre-commit-config.yaml', '.editorconfig')


def is_dependency_file(path):
    return Path(path).name in ('package.json', 'package-lock.json', 'packages.lock.json', 'requirements.txt', 'Directory.Packages.props')


def guess_class(subject, author, files):
    """The class of an upstream commit from its message and paths. A guess: the porting agent confirms it."""
    lowered = subject.lower()
    if 'dependabot' in author.lower() or re.search(r'\(deps(-dev)?\)', lowered) or re.match(r'^(chore|build)(\([^)]*\))*: bump ', lowered):
        return 'deps'
    if files and all(path in VERSION_FILES for path in files):
        return 'release'
    if VERSION_SUBJECT.match(subject):
        return 'release'
    if 'weblate' in lowered or (files and all(is_locale(path) for path in files)):
        return 'translation'
    if files and all(is_ci(path) for path in files):
        return 'ci'
    if files and all(is_dependency_file(path) for path in files):
        return 'deps'
    if files and all(is_docs(path) for path in files):
        return 'docs'
    if files and all(is_test(path) or is_docs(path) for path in files):
        return 'test'
    match = PREFIX.match(subject)
    if match and match.group(1).lower() in PREFIX_CLASS:
        guessed = PREFIX_CLASS[match.group(1).lower()]
        # A `chore:`/`refactor:` that changes shipped code is not housekeeping: someone has to look at it.
        if guessed == 'ci' and any(path.startswith(PLUGIN) for path in files):
            return 'unclassified'
        return guessed
    if re.search(r'\b(cve-\d|vulnerab|xss|csrf|injection|authori[sz]ation bypass)', lowered):
        return 'security'
    return 'unclassified'


# Upstream folder names that have no file of the same name in the rewrite yet (a new upstream file).
KEYWORD_FEATURES = (('spoiler', 'spoiler-guard'), ('jellyseerr', 'seerr'), ('seerr', 'seerr'), ('watchlist', 'seerr'),
                    ('postertag', 'media-tags'), ('tagcache', 'media-tags'), ('/tags/', 'media-tags'), ('/tests/poster/', 'media-tags'),
                    ('hidden', 'hidden-content'), ('bookmark', 'bookmarks'), ('calendar', 'calendar'),
                    ('catchup', 'catchup'), ('activity', 'activity'), ('/arr/requests', 'downloads'),
                    ('/player/', 'player'), ('settingspanel', 'settings-panel'))


class FeatureMapper:
    """Maps an upstream path to the rewrite feature that owns it, through the rewrite's own maps:
    client/entries/*.json (shipped script -> TypeScript source), docs/feature-map.json (folder -> feature)
    and, for C# and tests, the folder of the file with the same name in this tree."""

    def __init__(self, root):
        root = Path(root)
        feature_map = json.loads((root / 'docs/feature-map.json').read_text())
        self.features = feature_map['features']
        self.backend_root = feature_map.get('backendRoot', 'Jellyfin.Plugin.JellyfinEnhanced/Features').rstrip('/')
        self.entries = {}
        for manifest in sorted((root / 'client/entries').glob('*.json')):
            self.entries.update(json.loads(manifest.read_text()))
        self.test_folders = {}
        for feature in self.features:
            for folders in feature.get('tests', {}).values():
                for folder in folders:
                    self.test_folders.setdefault(folder, set()).add(feature['name'])
        self.by_name = {}
        tracked = git(root, 'ls-files', '--', PLUGIN, 'tests', check=False).splitlines()
        for path in tracked:
            if path.endswith(('.cs', '.mjs', '.cjs')):
                self.by_name.setdefault(Path(path).name, []).append(path)

    def of_client_source(self, source):
        best = None
        for feature in self.features:
            for folder in feature.get('client', []):
                if source.startswith(folder + '/') and (best is None or len(folder) > best[0]):
                    best = (len(folder), feature['name'])
        return best[1] if best else None

    def of_tree_path(self, path):
        shared = PLUGIN + 'Shared/'
        if path.startswith(self.backend_root + '/') or path.startswith(shared):
            area = path[len(self.backend_root) + 1:].split('/')[0] if path.startswith(self.backend_root + '/') else path[len(shared):].split('/')[0]
            for feature in self.features:
                if feature.get('backend') == area:
                    return feature['name']
            return 'platform'
        if path.startswith(PLUGIN + 'Configuration/'):
            return 'settings' if path.endswith('.cs') else 'admin'
        if path.startswith((PLUGIN + 'Infrastructure/', PLUGIN + 'Transport/')) or (path.startswith(PLUGIN) and path.count('/') == 1):
            return 'platform'
        if path.startswith('tests/'):
            # A test folder several features share (tests/frontend/pages) says nothing about the owner.
            best = None
            for folder, owners in self.test_folders.items():
                if len(owners) == 1 and path.startswith(folder + '/') and (best is None or len(folder) > best[0]):
                    best = (len(folder), next(iter(owners)))
            return best[1] if best else None
        return None

    def feature_of(self, path):
        """The owning feature's name, or None when the path belongs to no feature (docs, CI) or cannot be mapped."""
        relative = path[len(PLUGIN):] if path.startswith(PLUGIN) else None
        if relative and relative in self.entries:
            return self.of_client_source(self.entries[relative])
        if is_locale(path):
            return 'platform'
        if relative and relative.startswith('Configuration/'):
            return 'settings' if relative.endswith('.cs') else 'admin'
        if path.endswith(('.cs', '.mjs', '.cjs')):
            for candidate in self.by_name.get(Path(path).name, []):
                feature = self.of_tree_path(candidate)
                if feature:
                    return feature
        lowered = '/' + path.lower()
        if path.startswith(PLUGIN) or is_test(path):
            for keyword, feature in KEYWORD_FEATURES:
                if keyword in lowered:
                    return feature
        return None

    def guess(self, files):
        """(sorted feature names, paths under the plugin or tests that no rule could place)."""
        found, unmapped = set(), []
        for path in files:
            feature = self.feature_of(path)
            if feature:
                found.add(feature)
            elif path.startswith(PLUGIN) and path not in VERSION_FILES:
                unmapped.append(path)
        return sorted(found), unmapped


def collapse(files, limit=6):
    """The touched paths, with a folder holding more than `limit` of them shown once as `folder/ (N files)`."""
    by_folder = {}
    for path in files:
        by_folder.setdefault(str(Path(path).parent), []).append(path)
    shown = []
    for folder, paths in by_folder.items():
        shown.extend([f'{folder}/ ({len(paths)} files)'] if len(paths) > limit else paths)
    return shown


def new_entry(repo, sha, mapper, tags):
    facts = describe(repo, sha)
    features, unmapped = mapper.guess(facts['files'])
    issues = sorted(set(re.findall(r'#\d+', facts['subject'] + '\n' + facts['body'])), key=lambda issue: int(issue[1:]))
    release = next((name for name, tagged in tags if tagged == sha or is_ancestor(repo, sha, tagged)), None)
    entry = {
        'sha': facts['sha'],
        'date': facts['date'],
        'subject': facts['subject'],
        'class': guess_class(facts['subject'], facts['author'], facts['files']),
        'features': features,
        'issues': issues,
        'release': release,
        'size': {'files': len(facts['files']), 'insertions': facts['insertions'], 'deletions': facts['deletions']},
        'paths': collapse(facts['files']),
        'status': 'pending',
        'rewriteCommits': [],
    }
    if unmapped:
        entry['unmappedPaths'] = collapse(unmapped)
    return entry


# -------------------------------------------------------------------------------------------------- the ledger

def validate(ledger):
    """Every rule a ledger must satisfy, as a list of messages (empty when valid)."""
    problems = []
    for key in ('upstream', 'base', 'entries'):
        if key not in ledger:
            problems.append(f'ledger: missing "{key}"')
    if problems:
        return problems
    if not re.fullmatch(r'[0-9a-f]{40}', str(ledger['base'])):
        problems.append('ledger: "base" must be a full commit SHA')
    seen = set()
    for index, entry in enumerate(ledger['entries']):
        where = f"entry {index + 1} ({str(entry.get('sha', '?'))[:10]})"
        sha = entry.get('sha', '')
        if not re.fullmatch(r'[0-9a-f]{40}', str(sha)):
            problems.append(f'{where}: "sha" must be a full commit SHA')
        if sha in seen:
            problems.append(f'{where}: listed twice')
        seen.add(sha)
        for field in ('date', 'subject', 'class', 'status'):
            if not entry.get(field):
                problems.append(f'{where}: missing "{field}"')
        if entry.get('class') not in CLASSES:
            problems.append(f"{where}: class {entry.get('class')!r} is not one of {', '.join(CLASSES)}")
        status = entry.get('status')
        if status not in STATUSES:
            problems.append(f"{where}: status {status!r} is not one of {', '.join(STATUSES)}")
            continue
        for field in STATUSES[status]:
            if not str(entry.get(field, '')).strip():
                problems.append(f'{where}: status "{status}" needs "{field}"')
        if status != 'pending' and entry.get('class') == 'unclassified':
            problems.append(f'{where}: classify it before it leaves "pending"')
        if status != 'ported' and entry.get('rewriteCommits'):
            problems.append(f'{where}: only a ported entry names rewrite commits')
        if entry.get('with') and entry['with'] not in {other.get('sha') for other in ledger['entries']}:
            problems.append(f"{where}: \"with\" names {entry['with'][:10]}, which is not in the ledger")
        try:
            parse_date(entry.get('date', ''))
        except ValueError:
            problems.append(f"{where}: date {entry.get('date')!r} is not ISO 8601")
    return problems


def parse_date(text):
    parsed = datetime.fromisoformat(str(text).replace('Z', '+00:00'))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def age_days(entry, now):
    return (now - parse_date(entry['date'])).total_seconds() / 86400


def trailer_commits(repo, head='HEAD'):
    """{upstream sha: [rewrite commits whose message carries `Upstream: <sha>`]}, oldest rewrite commit first."""
    found = {}
    out = git(repo, 'log', '--reverse', '--format=%H%x00%(trailers:key=Upstream,valueonly,separator=%x01)%x02', head, check=False)
    for record in out.split('\x02'):
        record = record.strip('\n')
        if '\x00' not in record:
            continue
        commit, values = record.split('\x00', 1)
        for value in values.split('\x01'):
            match = re.match(r'[0-9a-f]{7,40}', value.strip())
            if match:
                found.setdefault(match.group(0), []).append(commit)
    return found


def resolve(repo, ledger, head='HEAD'):
    """Set rewriteCommits of every ported entry to the commits carrying its `Upstream:` trailer. Returns
    (number of entries changed, ported entries with no such commit)."""
    trailers = trailer_commits(repo, head)
    changed, missing = 0, []
    for entry in ledger['entries']:
        if entry.get('status') != 'ported':
            continue
        commits = [commit for key, commits in trailers.items() if entry['sha'].startswith(key) for commit in commits]
        if not commits:
            if not entry.get('rewriteCommits'):
                missing.append(entry)
            continue
        if entry.get('rewriteCommits') != commits:
            entry['rewriteCommits'] = commits
            changed += 1
    return changed, missing


def cell(text):
    return str(text).replace('|', '\\|').replace('\n', ' ')


def render(ledger):
    """docs/upstream-sync.md: the ledger as a table. Deterministic, so `render --check` can compare it."""
    entries = ledger['entries']
    counts = {status: sum(1 for entry in entries if entry['status'] == status) for status in STATUSES}
    url = ledger['upstream']['url'].removesuffix('.git')
    lines = [
        '<!-- Generated by scripts/upstream_sync.py from docs/upstream-sync.json. Edit the JSON, then run',
        '     `python3 scripts/upstream_sync.py render`. -->',
        '# Upstream sync ledger',
        '',
        f"What the rewrite has taken from [upstream]({url}) (`{ledger['upstream']['branch']}`) since it branched at "
        f"`{ledger['base'][:10]}`. The source of truth is [`upstream-sync.json`](upstream-sync.json); the procedure is "
        '[upstream-sync-procedure.md](upstream-sync-procedure.md).',
        '',
        f"{len(entries)} upstream commits: " + ', '.join(f'{counts[status]} {status}' for status in STATUSES if counts[status]) + '.',
        '',
        '| # | Upstream | Date | Class | Features | Subject | Status | Rewrite commit | Note |',
        '|---|---|---|---|---|---|---|---|---|',
    ]
    for index, entry in enumerate(entries, 1):
        note = entry.get('reason') or entry.get('evidence') or entry.get('notes') or ''
        if entry.get('needs'):
            note += f" Needs: {entry['needs']}"
        if entry.get('with'):
            note = f"With `{entry['with'][:8]}`. " + note
        commits = ', '.join(f'`{commit[:8]}`' for commit in entry.get('rewriteCommits', []))
        release = f" ({entry['release']})" if entry.get('release') else ''
        lines.append('| ' + ' | '.join([
            str(index), f"[`{entry['sha'][:8]}`]({url}/commit/{entry['sha']})", entry['date'][:10] + release, entry['class'],
            cell(', '.join(entry.get('features', []))), cell(entry['subject']), entry['status'], commits, cell(note.strip()),
        ]) + ' |')
    return '\n'.join(lines) + '\n'


def work_list(ledger, now, extra=()):
    """The open work, oldest first: one line per pending or deferred entry (and per unlisted upstream commit)."""
    lines = []
    for entry in list(ledger['entries']) + list(extra):
        if entry['status'] not in OPEN:
            continue
        size = entry.get('size', {})
        lines.append(f"{entry['status']:9} {entry['sha'][:10]} {entry['date'][:10]} {age_days(entry, now):5.0f}d  "
                     f"{entry['class']:12} {','.join(entry.get('features', [])) or '-':24} "
                     f"+{size.get('insertions', 0)}/-{size.get('deletions', 0)} in {size.get('files', 0)}  {entry['subject']}")
        if entry['status'] == 'pending':
            lines.append(f"{'':9} how: {HOW[entry['class']].format(sha=entry['sha'][:10])}")
        if entry.get('unmappedPaths'):
            lines.append(f"{'':9} unmapped: {', '.join(entry['unmappedPaths'])}")
        if entry['status'] == 'deferred':
            lines.append(f"{'':9} deferred: {entry.get('reason', '')} Needs: {entry.get('needs', '')}")
    return lines


def unlisted(repo, ledger, tip, mapper=None):
    """Entries for the upstream commits after the ledger's base that it does not list, oldest first."""
    listed = {entry['sha'] for entry in ledger['entries']}
    missing = [sha for sha in upstream_commits(repo, ledger['base'], tip) if sha not in listed]
    if not missing:
        return []
    mapper = mapper or FeatureMapper(repo)
    tags = release_tags(repo, ledger['base'], tip)
    return [new_entry(repo, sha, mapper, tags) for sha in missing]


def upstream_tip(repo, ledger, do_fetch, upstream_ref):
    if upstream_ref:
        if not ref_exists(repo, upstream_ref):
            raise SyncError(f'{upstream_ref} is not a commit here')
        return upstream_ref
    ref = REF_BRANCH.format(branch=ledger['upstream']['branch'])
    if do_fetch:
        return fetch(repo, ledger['upstream']['url'], ledger['upstream']['branch'])
    if not ref_exists(repo, ref):
        raise SyncError(f'{ref} does not exist yet: run without --no-fetch once, or pass --upstream-ref')
    return ref


# ---------------------------------------------------------------------------------------------------- commands

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('command', choices=['update', 'list', 'resolve', 'render', 'check'])
    parser.add_argument('--repo', type=Path, default=ROOT, help='the rewrite checkout (default: this one)')
    parser.add_argument('--ledger', help=f'ledger path (default: {LEDGER} in the checkout)')
    parser.add_argument('--no-fetch', action='store_true', help='update: use the upstream ref already here')
    parser.add_argument('--fetch', action='store_true', help='check: also read upstream and count unlisted commits as pending')
    parser.add_argument('--upstream-ref', help='use this local ref as upstream instead of fetching (for example origin/main)')
    parser.add_argument('--max-pending-days', type=float, help='check: the oldest a pending entry may be (default: the ledger policy, else 14)')
    parser.add_argument('--now', help='check, list: the current time as ISO 8601 (tests)')
    parser.add_argument('--check', action='store_true', help='render: compare instead of writing')
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    ledger_path = Path(args.ledger) if args.ledger else repo / LEDGER
    table_path = ledger_path.with_suffix('.md')
    now = parse_date(args.now) if args.now else datetime.now(timezone.utc)
    try:
        ledger = load_ledger(ledger_path)
        problems = validate(ledger)
        if problems and args.command != 'check':
            raise SyncError('the ledger is invalid:\n  ' + '\n  '.join(problems))

        if args.command == 'update':
            tip = upstream_tip(repo, ledger, not args.no_fetch, args.upstream_ref)
            added = unlisted(repo, ledger, tip)
            ledger['entries'].extend(added)
            resolve(repo, ledger)
            save_ledger(ledger_path, ledger)
            table_path.write_text(render(ledger))
            print(f"upstream {git(repo, 'rev-parse', tip).strip()[:10]}: {len(added)} new commit(s) appended as pending")
            lines = work_list(ledger, now)
            print('\n'.join(lines) if lines else 'nothing to do: no pending or deferred entries')
            return 0

        if args.command == 'list':
            lines = work_list(ledger, now)
            print('\n'.join(lines) if lines else 'nothing to do: no pending or deferred entries')
            return 0

        if args.command == 'resolve':
            changed, missing = resolve(repo, ledger)
            save_ledger(ledger_path, ledger)
            table_path.write_text(render(ledger))
            print(f'{changed} ported entr{"y" if changed == 1 else "ies"} updated from Upstream: trailers')
            for entry in missing:
                print(f"no commit carries `Upstream: {entry['sha']}` ({entry['subject']})", file=sys.stderr)
            return 1 if missing else 0

        if args.command == 'render':
            text = render(ledger)
            if not args.check:
                table_path.write_text(text)
                return 0
            if not table_path.exists() or table_path.read_text() != text:
                print(f'{table_path} is stale: run `python3 scripts/upstream_sync.py render`', file=sys.stderr)
                return 1
            return 0

        # check
        failures = list(problems)
        extra = []
        if not problems:
            if not table_path.exists() or table_path.read_text() != render(ledger):
                failures.append(f'{table_path.name} is stale: run `python3 scripts/upstream_sync.py render`')
            if args.fetch or args.upstream_ref:
                extra = unlisted(repo, ledger, upstream_tip(repo, ledger, args.fetch, args.upstream_ref))
            limit = args.max_pending_days
            if limit is None:
                limit = float(os.environ.get('JE_UPSTREAM_SYNC_MAX_PENDING_DAYS') or ledger.get('policy', {}).get('maxPendingDays', 14))
            pending = [entry for entry in list(ledger['entries']) + extra if entry['status'] == 'pending']
            for entry in pending:
                if age_days(entry, now) > limit:
                    listed = '' if entry in ledger['entries'] else ' (not in the ledger yet: run `update`)'
                    failures.append(f"pending for {age_days(entry, now):.0f} days (limit {limit:g}): {entry['sha'][:10]} {entry['subject']}{listed}")
            _, missing = resolve(repo, json.loads(json.dumps(ledger)))
            for entry in missing:
                failures.append(f"ported, but no commit carries `Upstream: {entry['sha']}`: {entry['subject']}")
            counts = {status: sum(1 for entry in ledger['entries'] if entry['status'] == status) for status in STATUSES}
            print(f"{len(ledger['entries'])} entries: " + ', '.join(f'{count} {status}' for status, count in counts.items() if count)
                  + (f'; {len(extra)} upstream commit(s) not listed' if extra else ''))
        if failures:
            print('upstream sync check failed:\n  ' + '\n  '.join(failures), file=sys.stderr)
            return 1
        return 0
    except SyncError as error:
        print(f'upstream_sync: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
