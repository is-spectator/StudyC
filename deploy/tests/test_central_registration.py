"""Offline transaction tests; synthetic releases, no network or service actions."""
import argparse
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DEPLOY))
from release_lib import describe, digest

spec = importlib.util.spec_from_file_location('central_registration', DEPLOY / 'activate-central-registration.py')
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)
BACKEND_RELEASE = 'source-sha256:' + '9' * 64


def release(base, html):
    manifest = describe({'index.html': html, 'assets/app.js': b'console.log("fixture")'})
    directory = base / 'releases' / manifest['releaseSha256']
    (directory / 'web' / 'assets').mkdir(parents=True)
    (directory / 'web' / 'index.html').write_bytes(html)
    (directory / 'web' / 'assets' / 'app.js').write_bytes(b'console.log("fixture")')
    (directory / 'release.json').write_text(json.dumps(manifest))
    return directory, manifest


class CentralRegistrationChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.study = self.root / 'study'
        self.ui = self.root / 'planplan-ui'
        self.backend = self.root / 'backend'
        self.old_study, _ = release(self.study, b'<html>old-study</html>')
        self.next_study, study_manifest = release(self.study, b'<html>next-study</html>')
        self.next_ui, ui_manifest = release(self.ui, b'<html>next-planplan</html>')
        (self.study / 'current').symlink_to('releases/' + self.old_study.name)
        self.backend_release = self.backend / 'releases' / ('9' * 64)
        self.backend_release.mkdir(parents=True)
        (self.backend / 'current').symlink_to(self.backend_release)
        self.configs = self.root / 'nginx'
        self.configs.mkdir()
        self.originals = {
            'clyna-study.conf': b'server {\n  root /opt/clyna-study/current/web;\n}\n',
            'zzz-planplan-web.conf': b'# original root host\r\nserver {\r\n\troot /opt/planplan-web/current/web; # preserve\r\n}\r\n',
            'clyna-planplan-alias.conf': b'server {\n    root /opt/planplan-web/current/web;\n}\n',
        }
        for name, contents in self.originals.items():
            (self.configs / name).write_bytes(contents)
        (self.configs / 'unrelated.conf').write_bytes(b'unrelated remains untouched')
        self.args = argparse.Namespace(study_release=self.next_study, planplan_ui_release=self.next_ui,
            nginx_conf_dir=self.configs, expected_study_config=digest(self.originals['clyna-study.conf']),
            expected_clyna_config=digest(self.originals['zzz-planplan-web.conf']),
            expected_planplan_config=digest(self.originals['clyna-planplan-alias.conf']),
            expected_study_current=str(self.old_study), expected_planplan_ui_current='absent',
            expected_planplan_backend_current=str(self.backend_release), expected_backend_release=BACKEND_RELEASE,
            backup_root=self.root / 'backups', nginx_bin='nginx', systemctl_bin='systemctl', curl_bin='curl')
        self.review = {'manifests': {'study': study_manifest, 'planplan': ui_manifest},
            'originals': {name: {'contents': contents, 'mode': 0o644, 'uid': 0, 'gid': 0} for name, contents in self.originals.items()},
            'configurations': {name: activation.replace_root(self.originals[name]) for name in activation.WRITABLE_CONFIGS},
            'previous': {'study': os.readlink(self.study / 'current'), 'planplan': None}}
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        for name, value in [('STUDY_BASE', self.study), ('UI_BASE', self.ui), ('BACKEND_BASE', self.backend)]:
            self.patches.enter_context(patch.object(activation, name, value))

    def test_root_change_preserves_every_other_byte_and_ignores_comments(self):
        original = b'# root /not/active;\r\nserver {\r\n\troot /opt/planplan-web/current/web ; # retained\r\n}\r\n'
        self.assertEqual(activation.replace_root(original), original.replace(activation.OLD_ROOT, activation.NEW_ROOT))
        for contents in [b'no root', b'root /different/web;',
                         b'root /opt/planplan-web/current/web;\nroot /opt/planplan-web/current/web;']:
            with self.assertRaises(ValueError):
                activation.replace_root(contents)

    def test_acme_roots_are_preserved_and_duplicate_application_roots_rejected(self):
        original = (b'server {\n  root /opt/planplan-web/current/web;\n'
                    b'  location /.well-known/acme-challenge/ {\n    root /var/lib/planplan-web-acme;\n  }\n'
                    b'  location /another-challenge/ { root /var/lib/planplan-web-acme; }\n}\n')
        self.assertEqual(activation.replace_root(original), original.replace(activation.OLD_ROOT, activation.NEW_ROOT))
        with self.assertRaises(ValueError):
            activation.replace_root(original + b'server { root /opt/planplan-web/current/web; }\n')

    def test_dry_check_has_no_writes_and_requires_all_three_config_hashes(self):
        with patch.object(activation, 'controlled'), patch.object(activation, 'guarded_link', return_value=None), patch.object(activation, 'command') as command, patch.object(activation, 'backend_ready'):
            activation.check(self.args)
            self.assertEqual(command.call_args_list[0].args[0], ['nginx', '-t'])
            for name in activation.CONFIGS:
                (self.configs / name).write_bytes(self.originals[name] + b'changed')
                with self.assertRaisesRegex(ValueError, 'configuration hash changed'):
                    activation.check(self.args)
                (self.configs / name).write_bytes(self.originals[name])
        self.assertFalse(self.args.backup_root.exists())
        self.assertFalse((self.ui / 'current').is_symlink())
        self.assertEqual((self.study / 'current').resolve(), self.old_study)

    def test_manifest_tampering_rejected_before_service_checks(self):
        (self.next_ui / 'web' / 'index.html').write_bytes(b'modified after review')
        with patch.object(activation, 'controlled'), patch.object(activation, 'command') as command:
            with self.assertRaises(ValueError):
                activation.check(self.args)
            command.assert_not_called()

    def test_link_guard_refuses_changed_or_unexpected_existing_target(self):
        with patch.object(activation, 'controlled'):
            with self.assertRaises(ValueError):
                activation.guarded_link(self.study / 'current', str(self.next_study), self.study / 'releases')
            with self.assertRaises(ValueError):
                activation.guarded_link(self.study / 'current', 'absent', self.study / 'releases')
            self.assertIsNone(activation.guarded_link(self.ui / 'current', 'absent', self.ui / 'releases'))

    def fixture_apply(self, link_effect=None, probe_error=None):
        def write(path, data, mode=0o644, **_):
            path.write_bytes(data)
            path.chmod(mode)
        stack = ExitStack()
        stack.enter_context(patch.object(activation.os, 'geteuid', return_value=0))
        stack.enter_context(patch.object(activation, 'controlled'))
        stack.enter_context(patch.object(activation, 'check', return_value=self.review))
        stack.enter_context(patch.object(activation, 'atomic_file', side_effect=write))
        command = stack.enter_context(patch.object(activation, 'command', return_value=b''))
        stack.enter_context(patch.object(activation, 'wait_for_probes', side_effect=probe_error))
        if link_effect:
            stack.enter_context(patch.object(activation, 'atomic_link', side_effect=link_effect))
        stack.enter_context(redirect_stdout(io.StringIO()))
        return stack, command

    def assert_restored(self):
        for name, contents in self.originals.items():
            self.assertEqual((self.configs / name).read_bytes(), contents)
        self.assertEqual(os.readlink(self.study / 'current'), self.review['previous']['study'])
        self.assertEqual((self.backend / 'current').resolve(), self.backend_release)
        self.assertEqual((self.configs / 'unrelated.conf').read_bytes(), b'unrelated remains untouched')
        journal_path = next(self.args.backup_root.glob('*/journal.json'))
        self.assertEqual(journal_path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(journal_path.stat().st_mode & 0o777, 0o600)
        journal = json.loads(journal_path.read_text())
        self.assertEqual(journal['state'], 'rolled-back')
        self.assertFalse(journal['backendChanged'])
        self.assertFalse(journal['databaseChanged'])

    def test_partial_initial_link_switch_restores_both_links_and_configs(self):
        atomic_link = activation.atomic_link
        def fail_second(link, target):
            if link == self.ui / 'current' and target == self.next_ui:
                raise OSError('synthetic second symlink switch failure')
            atomic_link(link, target)
        stack, command = self.fixture_apply(link_effect=fail_second)
        with stack:
            with self.assertRaises(OSError):
                activation.apply(self.args)
        self.assert_restored()
        self.assertFalse((self.ui / 'current').is_symlink())
        self.assertTrue(all('restart' not in call.args[0] for call in command.call_args_list))

    def test_failed_probes_restore_an_existing_planplan_ui_link(self):
        old_ui, _ = release(self.ui, b'<html>old-ui</html>')
        (self.ui / 'current').symlink_to('releases/' + old_ui.name)
        self.review['previous']['planplan'] = os.readlink(self.ui / 'current')
        stack, _ = self.fixture_apply(probe_error=RuntimeError('synthetic failed probe'))
        with stack:
            with self.assertRaises(RuntimeError):
                activation.apply(self.args)
        self.assert_restored()
        self.assertEqual(os.readlink(self.ui / 'current'), self.review['previous']['planplan'])

    def test_success_changes_only_two_configs_and_two_static_links(self):
        stack, command = self.fixture_apply()
        with stack:
            activation.apply(self.args)
        for name, contents in self.review['configurations'].items():
            self.assertEqual((self.configs / name).read_bytes(), contents)
        self.assertEqual((self.configs / 'clyna-study.conf').read_bytes(), self.originals['clyna-study.conf'])
        self.assertEqual((self.study / 'current').resolve(), self.next_study)
        self.assertEqual((self.ui / 'current').resolve(), self.next_ui)
        self.assertEqual((self.backend / 'current').resolve(), self.backend_release)
        self.assertEqual(json.loads(next(self.args.backup_root.glob('*/journal.json')).read_text())['state'], 'activated-and-probed')
        self.assertEqual([call.args[0] for call in command.call_args_list], [['nginx', '-t'], ['systemctl', 'reload', 'nginx']])

    def test_backend_release_must_remain_exact(self):
        for response in [{'ok': True, 'release': 'source-sha256:' + '0' * 64}, {'ok': False, 'release': BACKEND_RELEASE}]:
            with patch.object(activation, 'local_get', return_value=json.dumps(response).encode()):
                with self.assertRaises(ValueError):
                    activation.backend_ready(self.args)
        with patch.object(activation, 'local_get', return_value=json.dumps({'ok': True, 'release': BACKEND_RELEASE}).encode()) as request:
            activation.backend_ready(self.args)
            self.assertEqual(request.call_count, 2)

    def test_https_requests_use_strict_loopback_tls_and_no_mutating_flags(self):
        with patch.object(activation, 'command', return_value=b'fixture') as command:
            activation.local_get(self.args, 'clyna.ai', '/login')
        call = command.call_args.args[0]
        self.assertIn('clyna.ai:443:127.0.0.1', call)
        self.assertEqual(call[-1], 'https://clyna.ai/login')
        self.assertFalse(set(call) & {'-k', '--insecure', '-X', '--request', '--data', '--location'})

    def test_get_retry_is_bounded_and_final_error_propagates(self):
        with patch.object(activation, 'probes', side_effect=[RuntimeError('old worker'), None]) as probes, patch.object(activation.time, 'sleep') as sleep:
            activation.wait_for_probes(self.args, self.review)
        self.assertEqual(probes.call_count, 2)
        sleep.assert_called_once_with(0.5)
        with patch.object(activation, 'probes', side_effect=RuntimeError('still unavailable')) as probes, patch.object(activation.time, 'sleep') as sleep:
            with self.assertRaises(RuntimeError):
                activation.wait_for_probes(self.args, self.review)
        self.assertEqual(probes.call_count, 10)
        self.assertEqual(sleep.call_count, 9)


if __name__ == '__main__':
    unittest.main()
