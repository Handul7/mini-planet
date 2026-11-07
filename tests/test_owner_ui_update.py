import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import sys
import hashlib

spec = importlib.util.spec_from_file_location('ui_update', Path(__file__).parents[1] / 'scripts/owner-ui-update.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def archive(self, bad=None):
        archive = self.base / 'ui.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            entries = [(name, b'public') for name in updater.PUBLIC - {'src', 'assets', 'vendor', 'config'}]
            entries += [(f'{folder}/file.txt', b'public') for folder in ['assets', 'vendor', 'config']]
            entries += [(f'src/{name}', b'code') for name in ['main.js', 'owner-client.js', 'owner-workspace.js']]
            for name, body in entries:
                member = tarfile.TarInfo(name); member.size = len(body)
                tar.addfile(member, io.BytesIO(body))
            if bad:
                tar.addfile(bad, io.BytesIO(b'x' * bad.size))
        return archive

    def test_public_tree_extracts_without_executable_permissions(self):
        dest = self.base / 'site'; dest.mkdir()
        updater.extract_ui(self.archive(), dest)
        self.assertTrue((dest / 'src/main.js').is_file())
        self.assertEqual((dest / 'src/main.js').stat().st_mode & 0o777, 0o644)

    def test_rejects_private_paths_traversal_and_links(self):
        for index, name in enumerate(['../outside', '/outside', 'src/../../outside', 'config/services.local.json', '.git/config', 'scripts/owner-server.py', 'assets/.env']):
            dest = self.base / f'bad-{index}'; dest.mkdir()
            bad = tarfile.TarInfo(name); bad.size = 1
            with self.subTest(name=name), self.assertRaises(ValueError):
                updater.extract_ui(self.archive(bad), dest)
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE]:
            dest = self.base / f'link-{kind!r}'; dest.mkdir()
            bad = tarfile.TarInfo('src/link'); bad.type = kind; bad.linkname = '/private'
            with self.assertRaises(ValueError):
                updater.extract_ui(self.archive(bad), dest)

    def test_rejects_duplicate_members(self):
        dest = self.base / 'duplicates'; dest.mkdir()
        bad = tarfile.TarInfo('index.html'); bad.size = 1
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            updater.extract_ui(self.archive(bad), dest)

    def test_release_identity_must_match_downloaded_commit(self):
        archive = self.archive()
        dest = self.base / 'no-identity'; dest.mkdir()
        with self.assertRaisesRegex(ValueError, 'missing_release_identity'):
            updater.extract_ui(archive, dest, expected_commit='a' * 40)
        for commit in ['a' * 40, 'b' * 40]:
            # Append the small public version stamp to the otherwise valid UI.
            with tarfile.open(archive, 'r:gz') as original:
                members = [(member, original.extractfile(member).read()) for member in original]
            with tarfile.open(archive, 'w:gz') as bundle:
                for member, body in members:
                    if member.name != 'src/owner-release.json': bundle.addfile(member, io.BytesIO(body))
                body = json.dumps({'commit': commit, 'apiContract': 1}).encode()
                member = tarfile.TarInfo('src/owner-release.json'); member.size = len(body)
                bundle.addfile(member, io.BytesIO(body))
            dest = self.base / commit; dest.mkdir()
            if commit.startswith('a'):
                updater.extract_ui(archive, dest, expected_commit='a' * 40)
            else:
                with self.assertRaisesRegex(ValueError, 'release_identity_mismatch'):
                    updater.extract_ui(archive, dest, expected_commit='a' * 40)

    def test_same_html_with_old_javascript_does_not_pass_deployment_health(self):
        responses = {'/index.html': b'unchanged HTML', '/src/main.js': b'old javascript',
                     '/owner/session': b'{"authenticated":false}'}
        requests = []
        class Connection:
            def __init__(self, *args, **kwargs): pass
            def request(self, method, path, headers): self.path = path; requests.append(path)
            def getresponse(self):
                self.status = 401 if self.path == '/owner/session' else 200
                return self
            def read(self, size): return responses[self.path]
            def close(self): pass
        fingerprints = {path: hashlib.sha256(body).hexdigest() for path, body in {
            '/index.html': b'unchanged HTML', '/src/main.js': b'new javascript'}.items()}
        with patch.object(updater.http.client, 'HTTPConnection', Connection), patch.object(updater.time, 'sleep'):
            self.assertFalse(updater.healthy({}, fingerprints))
            self.assertIn('/src/main.js', requests)
            responses['/src/main.js'] = b'new javascript'
            self.assertTrue(updater.healthy({}, fingerprints))

    def config(self):
        root = self.base / '_site'; root.mkdir(); (root / 'index.html').write_text('old')
        state = self.base / 'private'; state.mkdir()
        staged = self.base / 'staged'; staged.mkdir(); (staged / 'index.html').write_text('new')
        return {'siteRoot': root, 'stateDir': state}, staged

    def test_success_restarts_only_owner_and_keeps_backup(self):
        config, staged = self.config(); actions = []
        updater.activate(config, staged, 'a' * 40, control=lambda _, action: actions.append(action), check=lambda *_: True)
        self.assertEqual(actions, ['stop', 'start'])
        self.assertEqual((config['siteRoot'] / 'index.html').read_text(), 'new')
        state = json.loads((config['stateDir'] / 'current.json').read_text())
        self.assertEqual((Path(state['previousSite']) / 'index.html').read_text(), 'old')
        self.assertFalse((config['stateDir'] / 'pending.json').exists())

    def test_failed_release_restores_old_site_and_has_no_success_record(self):
        config, staged = self.config(); actions = []; health = iter([True, False, True])
        with self.assertRaisesRegex(ValueError, 'new_ui_healthcheck_failed') as caught:
            updater.activate(config, staged, 'b' * 40, control=lambda _, action: actions.append(action), check=lambda *_: next(health))
        self.assertEqual(actions, ['stop', 'start', 'stop', 'start'])
        self.assertEqual((config['siteRoot'] / 'index.html').read_text(), 'old')
        self.assertFalse((config['stateDir'] / 'current.json').exists())
        self.assertFalse((config['stateDir'] / 'pending.json').exists())
        self.assertTrue(caught.exception.quarantine_release)

    def test_failed_rollback_retains_recovery_journal(self):
        config, staged = self.config(); health = iter([True, False, False])
        with self.assertRaisesRegex(ValueError, 'rollback_healthcheck_failed'):
            updater.activate(config, staged, 'c' * 40, control=lambda *_: None, check=lambda *_: next(health))
        self.assertTrue((config['stateDir'] / 'pending.json').exists())
        self.assertEqual((config['siteRoot'] / 'index.html').read_text(), 'old')

    def test_unhealthy_existing_owner_does_not_stop_or_swap(self):
        config, staged = self.config(); actions = []
        with self.assertRaisesRegex(ValueError, 'existing_owner_healthcheck_failed') as caught:
            updater.activate(config, staged, 'd' * 40, control=lambda _, action: actions.append(action), check=lambda *_: False)
        self.assertEqual(actions, [])
        self.assertEqual((config['siteRoot'] / 'index.html').read_text(), 'old')
        self.assertFalse(getattr(caught.exception, 'quarantine_release', False))

    def test_journal_cleanup_failure_keeps_committed_ui_and_metadata_consistent(self):
        config, staged = self.config()
        real_unlink = Path.unlink
        def fail_journal(path, *args, **kwargs):
            if path.name == 'pending.json': raise OSError('simulated cleanup failure')
            return real_unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail_journal), self.assertRaises(OSError):
            updater.activate(config, staged, 'e' * 40, control=lambda *_: None, check=lambda *_: True)
        self.assertEqual((config['siteRoot'] / 'index.html').read_text(), 'new')
        self.assertEqual(json.loads((config['stateDir'] / 'current.json').read_text())['commit'], 'e' * 40)
        self.assertTrue((config['stateDir'] / 'pending.json').exists())

    def test_existing_virtualenv_python_symlink_is_supported(self):
        config, _ = self.config()
        helper = self.base / 'ownerctl.py'; helper.write_text('# test helper')
        python = self.base / 'venv-python'; python.symlink_to(sys.executable)
        path = self.base / 'update.json'
        path.write_text(json.dumps({**{key: str(value.resolve()) for key, value in config.items()},
            'python': str(python), 'ownerctl': str(helper.resolve()), 'repo': 'Handul7/mini-planet'}))
        path.chmod(0o600)
        self.assertEqual(updater.load_config(path)['python'], python)

    def test_rejects_incompatible_manifest(self):
        value = {'schemaVersion': 1, 'apiContract': 1, 'commit': 'a' * 40, 'sha256': 'f' * 64}
        self.assertEqual(updater.validate_manifest(value, 'a' * 40), value)
        for change in [{'apiContract': 2}, {'apiContract': True}, {'schemaVersion': True}, {'sha256': 'invalid'}, {'commit': 'b' * 40}]:
            with self.assertRaises(ValueError):
                updater.validate_manifest({**value, **change}, 'a' * 40)


if __name__ == '__main__':
    unittest.main()
