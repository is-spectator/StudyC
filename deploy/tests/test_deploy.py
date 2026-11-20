"""Offline deployment safety checks, using synthetic files only."""
import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DEPLOY))
from release_lib import add_tar_file, collect, describe, read_archive


def module(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), DEPLOY / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


renderer = module('render-config')
origins = module('merge-origins')
activation = module('activate-release')


class ReleaseChecks(unittest.TestCase):
    def test_release_manifest_detects_modified_artifact(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'candidate.tar.gz'
            files = {'index.html': b'<html>fixture</html>', 'assets/app.js': b'console.log("fixture")'}
            manifest = describe(files)
            with tarfile.open(archive, 'w:gz') as bundle:
                add_tar_file(bundle, 'release.json', json.dumps(manifest).encode())
                for name, data in files.items():
                    add_tar_file(bundle, 'web/' + name, data)
            self.assertEqual(read_archive(archive)[0], manifest)
            with tarfile.open(archive, 'w:gz') as bundle:
                add_tar_file(bundle, 'release.json', json.dumps(manifest).encode())
                for name, data in files.items():
                    add_tar_file(bundle, 'web/' + name, data + b'tampered')
            with self.assertRaises(ValueError):
                read_archive(archive)

    def test_traversal_and_symlink_archives_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                add_tar_file(bundle, 'web/../../escape.html', b'x')
            with self.assertRaises(ValueError):
                read_archive(archive)
            with tarfile.open(archive, 'w:gz') as bundle:
                item = tarfile.TarInfo('web/index.html')
                item.type = tarfile.SYMTYPE
                item.linkname = '/etc/passwd'
                bundle.addfile(item)
            with self.assertRaises(ValueError):
                read_archive(archive)

    def test_build_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'index.html').write_text('fixture')
            (root / 'linked.txt').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                collect(root)

    def test_merge_preserves_existing_origins_and_never_returns_other_config(self):
        result = origins.merge('AN_UNRELATED_FIELD=not-for-output\nWEB_ALLOWED_ORIGINS="https://clyna.ai,https://www.clyna.ai"\n')
        self.assertEqual(result, 'WEB_ALLOWED_ORIGINS=https://clyna.ai,https://www.clyna.ai,https://study.clyna.ai,https://planplan.clyna.ai\n')
        self.assertEqual(origins.merge(result), result)
        for text in ['WEB_ALLOWED_ORIGINS=\n', 'WEB_ALLOWED_ORIGINS=https://clyna.ai/path\n', 'WEB_ALLOWED_ORIGINS=https://clyna.ai\nWEB_ALLOWED_ORIGINS=https://other.test\n']:
            with self.assertRaises(ValueError):
                origins.merge(text)

    def test_auth_allowlist_uses_cookie_routes_and_denies_everything_else(self):
        self.assertEqual(len(renderer.AUTH_METHODS), 7)
        self.assertEqual(renderer.AUTH_METHODS['/v1/auth/web/email/reset'], 'POST')
        self.assertNotIn('/v1/auth/email/login', renderer.AUTH_METHODS)
        template = (DEPLOY / 'nginx/study.conf.in').read_text()
        self.assertIn('location ^~ /v1 { return 404; }', template)
        self.assertIn('proxy_set_header Origin $http_origin;', renderer.PROXY_DIRECTIVES)
        self.assertIn('proxy_set_header Host $http_host;', renderer.PROXY_DIRECTIVES)
        self.assertIn('proxy_next_upstream off;', renderer.PROXY_DIRECTIVES)
        for value in ['/certs/valid.pem; return 200;', '/certs/../private.pem', '/path/with space.pem']:
            with self.assertRaises(ValueError):
                renderer.safe_path(value)

    def test_failed_activation_restores_only_owned_configs_and_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            base = root / 'study'
            base.mkdir()
            previous = base / 'previous'
            previous.mkdir()
            release = base / 'next'
            release.mkdir()
            (base / 'current').symlink_to(previous)
            configs = root / 'nginx'
            configs.mkdir()
            (configs / 'clyna-study.conf').write_bytes(b'old-study-config')
            (configs / 'existing-clyna.conf').write_bytes(b'untouched-original')
            args = argparse.Namespace(release=release, rendered=root, nginx_conf_dir=configs, backup_root=root / 'backups', confirmed_host_review=True, origins_reviewed=True, nginx_bin='nginx', systemctl_bin='systemctl', curl_bin='curl')
            manifest = {'releaseSha256': 'f' * 64}
            new_configs = {'clyna-study.conf': b'new-study', 'clyna-planplan-alias.conf': b'new-alias'}
            def fake_atomic(path, data, **kwargs):
                path.write_bytes(data)
            with patch.object(activation, 'BASE', base), patch.object(activation.os, 'geteuid', return_value=0), patch.object(activation, 'check', return_value=(manifest, new_configs, str(previous))), patch.object(activation, 'command', return_value=b''), patch.object(activation, 'atomic_file', side_effect=fake_atomic), patch.object(activation, 'probes', side_effect=RuntimeError('synthetic probe failure')), patch.object(activation.time, 'sleep'), redirect_stdout(io.StringIO()):
                with self.assertRaises(RuntimeError):
                    activation.apply(args)
            self.assertEqual((configs / 'clyna-study.conf').read_bytes(), b'old-study-config')
            self.assertFalse((configs / 'clyna-planplan-alias.conf').exists())
            self.assertEqual((configs / 'existing-clyna.conf').read_bytes(), b'untouched-original')
            self.assertEqual((base / 'current').resolve(), previous.resolve())
            journal = json.loads(next((root / 'backups').glob('*/journal.json')).read_text())
            self.assertEqual(journal['state'], 'rolled-back')
            self.assertFalse(journal['databaseChanged'])

    def test_post_reload_gets_retry_until_workers_are_ready(self):
        with patch.object(activation, 'probes', side_effect=[RuntimeError('curl return code 60'), ValueError('old worker'), None]) as probe, patch.object(activation.time, 'sleep') as sleep:
            activation.wait_for_probes(argparse.Namespace(), {}, {})
        self.assertEqual(probe.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertTrue(all(call.args == (0.5,) for call in sleep.call_args_list))

    def test_post_reload_retry_is_bounded_and_error_propagates(self):
        with patch.object(activation, 'probes', side_effect=RuntimeError('curl return code 60')) as probe, patch.object(activation.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'curl return code 60'):
                activation.wait_for_probes(argparse.Namespace(), {}, {})
        self.assertEqual(probe.call_count, 10)
        self.assertEqual(sleep.call_count, 9)


if __name__ == '__main__':
    unittest.main()
