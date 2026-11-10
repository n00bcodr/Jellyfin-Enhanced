"""scripts/upstream_sync.py: the upstream ledger grows by itself, stays truthful and can never write upstream."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = 'Jellyfin.Plugin.JellyfinEnhanced/'
GIT_ENV = {**os.environ, 'GIT_AUTHOR_NAME': 'Upstream Author', 'GIT_AUTHOR_EMAIL': 'author@example.invalid',
           'GIT_COMMITTER_NAME': 'Upstream Author', 'GIT_COMMITTER_EMAIL': 'author@example.invalid',
           'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}


def load():
    spec = importlib.util.spec_from_file_location('upstream_sync', ROOT / 'scripts/upstream_sync.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sync = load()


def sh(repo, *args, date=None, author=None):
    env = dict(GIT_ENV)
    if date:
        env.update(GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    if author:
        env.update(GIT_AUTHOR_NAME=author)
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True, env=env).stdout.strip()


def commit(repo, subject, files, date, body='', author=None):
    for path, text in files.items():
        target = Path(repo) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', subject + ('\n\n' + body if body else ''), date=date, author=author)
    return sh(repo, 'rev-parse', 'HEAD')


class Repos:
    """An `upstream` repository and a `rewrite` clone of its first commit that carries the rewrite's maps and a ledger."""

    def __init__(self, temp):
        self.upstream = Path(temp) / 'upstream'
        self.rewrite = Path(temp) / 'rewrite'
        self.upstream.mkdir()
        sh(self.upstream, 'init', '-q', '-b', 'main')
        self.base = commit(self.upstream, 'base', {
            PLUGIN + 'js/enhanced/player/playback.js': '// player\n',
            PLUGIN + 'Services/SpoilerGuard/SpoilerFieldStripFilter.cs': '// filter\n',
            'tests/frontend/pages/pages-x.test.mjs': '// pages\n',
        }, '2026-01-01T00:00:00+00:00')
        sh(self.upstream.parent, 'clone', '-q', str(self.upstream), str(self.rewrite))
        commit(self.rewrite, 'rewrite: restructure', {
            'docs/feature-map.json': json.dumps({'backendRoot': PLUGIN + 'Features', 'features': [
                {'name': 'player', 'client': ['client/src/features/player'], 'backend': None,
                 'tests': {'frontend': ['tests/frontend/features/player', 'tests/frontend/pages']}},
                {'name': 'spoiler-guard', 'client': ['client/src/features/spoiler-guard'], 'backend': 'SpoilerGuard',
                 'tests': {'frontend': ['tests/frontend/pages'], 'backend': ['tests/backend/Features/SpoilerGuard']}},
                {'name': 'platform', 'client': ['client/src/core', 'client/src/features/shared'], 'backend': 'Platform', 'tests': {}},
            ]}),
            'client/entries/player.json': json.dumps({'js/enhanced/player/playback.js': 'client/src/features/player/playback.ts'}),
            PLUGIN + 'Shared/SpoilerGuard/SpoilerFieldStripFilter.cs': '// moved\n',
            'docs/upstream-sync.json': json.dumps({'upstream': {'url': str(self.upstream), 'branch': 'main'}, 'base': self.base,
                                                   'policy': {'maxPendingDays': 14}, 'entries': []}),
        }, '2026-01-02T00:00:00+00:00')

    def run(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sync.main([*args, '--repo', str(self.rewrite)])
        return code, out.getvalue(), err.getvalue()

    def ledger(self):
        return json.loads((self.rewrite / 'docs/upstream-sync.json').read_text())

    def edit(self, sha, **fields):
        ledger = self.ledger()
        next(entry for entry in ledger['entries'] if entry['sha'] == sha).update(fields)
        (self.rewrite / 'docs/upstream-sync.json').write_text(json.dumps(ledger))


class UpstreamSyncTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.repos = Repos(temp.name)

    def test_update_appends_unlisted_commits_as_pending_with_guessed_class_and_features(self):
        r = self.repos
        feat = commit(r.upstream, 'feat(player): subtitle offset shortcuts', {PLUGIN + 'js/enhanced/player/playback.js': '// more\n'},
                      '2026-02-01T10:00:00+00:00', body='Fixes #1012')
        sh(r.upstream, 'tag', '12.15.0.0')
        fix = commit(r.upstream, 'fix(spoiler-guard): strip rows (#1033)', {
            PLUGIN + 'Services/SpoilerGuard/SpoilerFieldStripFilter.cs': '// fixed\n', 'tests/frontend/pages/pages-x.test.mjs': '// t\n',
            PLUGIN + 'Controllers/JellyfinEnhancedController.cs': '// one big controller\n'}, '2026-02-02T10:00:00+00:00')
        code, out, err = r.run('update', '--now', '2026-02-03T10:00:00+00:00')
        self.assertEqual(0, code, err)
        first, second = r.ledger()['entries']
        self.assertEqual((feat, 'feature', ['player'], ['#1012'], '12.15.0.0', 'pending'),
                         (first['sha'], first['class'], first['features'], first['issues'], first['release'], first['status']))
        self.assertEqual({'files': 1, 'insertions': 1, 'deletions': 1}, first['size'])
        # The shared tests/frontend/pages folder names no owner; the moved C# file is found by name in Shared/.
        self.assertEqual((fix, 'fix', ['spoiler-guard'], ['#1033'], None), (second['sha'], second['class'], second['features'], second['issues'], second['release']))
        self.assertEqual([PLUGIN + 'Controllers/JellyfinEnhancedController.cs'], second['unmappedPaths'])
        self.assertIn('2 new commit(s) appended as pending', out)
        self.assertIn('how: re-implement in the owning feature; upstream\'s tests first; lab parity', out)
        self.assertIn('unmapped: ' + PLUGIN + 'Controllers/JellyfinEnhancedController.cs', out)
        self.assertIn('| pending |', (r.rewrite / 'docs/upstream-sync.md').read_text())

    def test_update_is_idempotent_and_keeps_hand_edits(self):
        r = self.repos
        sha = commit(r.upstream, 'docs: explain', {'docs/a.md': 'a\n'}, '2026-02-01T10:00:00+00:00')
        code, out, _ = r.run('update', '--fetch')   # fetching is the default; the flag is accepted
        self.assertEqual(0, code)
        self.assertIn(f'how: applies as is where the page exists: git show {sha[:10]} | git apply --3way', out)
        r.edit(sha, status='not-applicable', reason='The rewrite has no such page.')
        later = commit(r.upstream, 'ci: faster', {'.github/workflows/x.yml': 'x\n'}, '2026-02-02T10:00:00+00:00')
        self.assertEqual(0, r.run('update')[0])
        self.assertEqual(0, r.run('update')[0])
        entries = r.ledger()['entries']
        self.assertEqual([(sha, 'docs', 'not-applicable'), (later, 'ci', 'pending')], [(e['sha'], e['class'], e['status']) for e in entries])
        self.assertEqual('The rewrite has no such page.', entries[0]['reason'])

    def test_a_run_that_starts_several_upstream_commits_behind_lists_all_of_them_oldest_first(self):
        r = self.repos
        first = commit(r.upstream, 'fix(player): seek', {PLUGIN + 'js/enhanced/player/playback.js': '// seek\n'}, '2026-02-01T10:00:00+00:00')
        self.assertEqual(0, r.run('update')[0])
        r.edit(first, status='deferred', reason='later', needs='a lab')
        later = [commit(r.upstream, subject, files, f'2026-02-0{day}T10:00:00+00:00') for day, (subject, files) in enumerate([
            ('v12.16.0.0', {PLUGIN + 'JellyfinEnhanced.csproj': '<v/>\n'}),
            ('ci: faster', {'.github/workflows/x.yml': 'x\n'}),
            ('feat(player): more', {PLUGIN + 'js/enhanced/player/playback.js': '// more\n'}),
        ], start=2)]
        code, out, _ = r.run('update', '--now', '2026-02-05T10:00:00+00:00')
        self.assertEqual(0, code)
        self.assertEqual([first, *later], [e['sha'] for e in r.ledger()['entries']])
        self.assertEqual(['deferred', 'pending', 'pending', 'pending'], [e['status'] for e in r.ledger()['entries']])
        self.assertIn('how: one chore(release) commit, last', out)
        self.assertIn(f'how: applies as is to the workflows this tree has: git show {later[1][:10]} | git apply --3way', out)

    def test_class_guesses_follow_paths_before_the_message(self):
        cases = [
            ('chore(ci)(deps): bump the github-actions group', 'dependabot[bot]', ['.github/workflows/a.yml'], 'deps'),
            ('v12.15.0.0', 'someone', [PLUGIN + 'JellyfinEnhanced.csproj'], 'release'),
            ('v12.15.0.0 - Jellyfin Enhanced (synced)', 'github-actions[bot]', ['manifest.json'], 'release'),
            ('Translations update from Hosted Weblate (#980)', 'Weblate', [PLUGIN + 'js/locales/de.json'], 'translation'),
            ('fix: typo', 'someone', [PLUGIN + 'js/locales/de.json', PLUGIN + 'js/locales/fr.json'], 'translation'),
            ('ci: skip browser tests', 'someone', ['.github/workflows/regression.yml'], 'ci'),
            ('fix(tests): point at the renamed endpoint', 'someone', ['tests/backend/A.cs'], 'test'),
            ('feat: explain', 'someone', ['docs/x.md', 'mkdocs.yml'], 'docs'),
            ('perf(tags): one sort', 'someone', [PLUGIN + 'Services/TagCacheService.cs'], 'performance'),
            ('refactor: move the planner', 'someone', [PLUGIN + 'Services/Planner.cs'], 'unclassified'),
            ('Media Tags redesign', 'someone', [PLUGIN + 'js/tags/x.js'], 'unclassified'),
            ('fix(seerr): escape titles (XSS)', 'someone', [PLUGIN + 'js/jellyseerr/api.js'], 'fix'),
        ]
        for subject, author, files, expected in cases:
            with self.subTest(subject=subject):
                self.assertEqual(expected, sync.guess_class(subject, author, files))

    def test_check_fails_on_old_pending_work_and_passes_once_it_is_decided(self):
        r = self.repos
        sha = commit(r.upstream, 'fix(player): seek', {PLUGIN + 'js/enhanced/player/playback.js': '// seek\n'}, '2026-02-01T10:00:00+00:00')
        self.assertEqual(0, r.run('update')[0])
        self.assertEqual(0, r.run('check', '--now', '2026-02-10T10:00:00+00:00')[0])
        code, _, err = r.run('check', '--now', '2026-02-20T10:00:00+00:00')
        self.assertEqual(1, code)
        self.assertIn('pending for 19 days (limit 14)', err)
        self.assertEqual(0, r.run('check', '--now', '2026-02-20T10:00:00+00:00', '--max-pending-days', '30')[0])
        self.assertEqual(1, r.run('check', '--now', '2026-02-10T10:00:00+00:00', '--max-pending-days', '3')[0])
        # A deferred entry is decided work: it stays on the work list but never fails the check.
        r.edit(sha, status='deferred', reason='Needs a route.', needs='The maintainer to accept the contract change.')
        self.assertEqual(0, r.run('render')[0])
        self.assertEqual(0, r.run('check', '--now', '2027-01-01T00:00:00+00:00')[0])
        self.assertIn('deferred: Needs a route. Needs: The maintainer', r.run('list')[1])

    def test_check_with_fetch_counts_upstream_commits_the_ledger_does_not_list(self):
        r = self.repos
        commit(r.upstream, 'fix(player): seek', {PLUGIN + 'js/enhanced/player/playback.js': '// seek\n'}, '2026-02-01T10:00:00+00:00')
        before = (r.rewrite / 'docs/upstream-sync.json').read_text()
        self.assertEqual(0, r.run('render')[0])
        self.assertEqual(0, r.run('check', '--now', '2026-03-01T00:00:00+00:00')[0])
        code, out, err = r.run('check', '--fetch', '--now', '2026-03-01T00:00:00+00:00')
        self.assertEqual(1, code)
        self.assertIn('1 upstream commit(s) not listed', out)
        self.assertIn('not in the ledger yet', err)
        self.assertEqual(before, (r.rewrite / 'docs/upstream-sync.json').read_text(), 'check never writes the ledger')

    def test_check_rejects_an_untruthful_ledger(self):
        r = self.repos
        sha = commit(r.upstream, 'Media Tags redesign', {PLUGIN + 'js/tags/x.js': 'x\n'}, '2026-02-01T10:00:00+00:00')
        self.assertEqual(0, r.run('update')[0])
        for fields, message in [
            ({'status': 'not-applicable'}, 'needs "reason"'),
            ({'status': 'deferred', 'reason': 'later'}, 'needs "needs"'),
            ({'status': 'already-present'}, 'needs "evidence"'),
            ({'status': 'done'}, "status 'done' is not one of"),
            ({'status': 'not-applicable', 'reason': 'x'}, 'classify it before it leaves "pending"'),
            ({'class': 'fix', 'status': 'ported'}, 'no commit carries `Upstream: ' + sha),
        ]:
            with self.subTest(fields=fields):
                saved = (r.rewrite / 'docs/upstream-sync.json').read_text()
                r.edit(sha, **fields)
                r.run('render')
                code, _, err = r.run('check', '--now', '2026-02-02T00:00:00+00:00')
                self.assertEqual(1, code)
                self.assertIn(message, err)
                (r.rewrite / 'docs/upstream-sync.json').write_text(saved)
        (r.rewrite / 'docs/upstream-sync.md').write_text('stale\n')
        self.assertIn('is stale', r.run('check', '--now', '2026-02-02T00:00:00+00:00')[2])

    def test_resolve_fills_rewrite_commits_from_upstream_trailers(self):
        r = self.repos
        one = commit(r.upstream, 'fix(player): seek', {PLUGIN + 'js/enhanced/player/playback.js': '// seek\n'}, '2026-02-01T10:00:00+00:00')
        two = commit(r.upstream, 'test(player): seek', {'tests/frontend/features/player/seek.test.mjs': '// t\n'}, '2026-02-01T11:00:00+00:00')
        self.assertEqual(0, r.run('update')[0])
        r.edit(one, status='ported')
        r.edit(two, status='ported', **{'with': one})
        port = commit(r.rewrite, 'fix(player): seek', {'client/src/features/player/playback.ts': '// seek\n'}, '2026-02-03T00:00:00+00:00',
                      body=f'Ported in the rewrite\'s structure.\n\nUpstream: {one}\nUpstream: {two}')
        code, out, err = r.run('resolve')
        self.assertEqual(0, code, err)
        self.assertEqual([[port], [port]], [entry['rewriteCommits'] for entry in r.ledger()['entries']])
        self.assertIn(f'`{port[:8]}`', (r.rewrite / 'docs/upstream-sync.md').read_text())
        self.assertEqual(0, r.run('check', '--now', '2026-02-04T00:00:00+00:00')[0])

    def test_a_rewritten_upstream_history_is_reported_not_guessed_around(self):
        r = self.repos
        ledger = r.ledger()
        ledger['base'] = 'f' * 40
        (r.rewrite / 'docs/upstream-sync.json').write_text(json.dumps(ledger))
        code, _, err = r.run('update')
        self.assertEqual(2, code)
        self.assertIn('is not an ancestor of upstream', err)

    def test_it_cannot_push_or_use_credentials_and_fetch_touches_no_branch(self):
        r = self.repos
        for subcommand in ('push', 'commit', 'remote', 'config', 'update-ref', 'send-pack'):
            with self.subTest(subcommand=subcommand), self.assertRaises(sync.SyncError):
                sync.git(r.rewrite, subcommand, 'origin', 'main')
        for url in ('ssh://git@example.invalid/x.git', 'git@example.invalid:x.git', 'ext::sh -c true', 'http://example.invalid/x.git'):
            with self.subTest(url=url), self.assertRaises(sync.SyncError):
                sync.fetch(r.rewrite, url, 'main')
        source = (ROOT / 'scripts/upstream_sync.py').read_text()
        self.assertEqual(1, source.count('subprocess.run('), 'every git call goes through run_git')
        self.assertNotIn("'push'", source.split('GIT_ALLOWED = ')[1].split(')')[0])
        commit(r.upstream, 'fix(player): seek', {PLUGIN + 'js/enhanced/player/playback.js': '// seek\n'}, '2026-02-01T10:00:00+00:00')
        self.assertEqual(0, r.run('render')[0])
        branches = sh(r.rewrite, 'for-each-ref', 'refs/heads', 'refs/remotes')
        head, status = sh(r.rewrite, 'rev-parse', 'HEAD'), sh(r.rewrite, 'status', '--porcelain', '--untracked-files=no')
        self.assertEqual(0, r.run('check', '--fetch', '--now', '2026-02-02T00:00:00+00:00', '--max-pending-days', '9999')[0])
        self.assertEqual((branches, head, status), (sh(r.rewrite, 'for-each-ref', 'refs/heads', 'refs/remotes'),
                                                    sh(r.rewrite, 'rev-parse', 'HEAD'), sh(r.rewrite, 'status', '--porcelain', '--untracked-files=no')))
        self.assertTrue(sh(r.rewrite, 'for-each-ref', 'refs/upstream-sync/main'))

    def test_the_committed_ledger_is_valid_and_its_table_is_current(self):
        ledger = json.loads((ROOT / 'docs/upstream-sync.json').read_text())
        self.assertEqual([], sync.validate(ledger))
        self.assertEqual(sync.render(ledger), (ROOT / 'docs/upstream-sync.md').read_text())
        mapper = sync.FeatureMapper(ROOT)
        known = {feature['name'] for feature in mapper.features}
        for entry in ledger['entries']:
            self.assertLessEqual(set(entry['features']), known, entry['sha'])


if __name__ == '__main__':
    unittest.main()
