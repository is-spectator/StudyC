"""Offline deployment safety checks, using synthetic files only."""
import argparse
import configparser
from contextlib import redirect_stdout
import importlib.util
import io
import json
import re
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

    def test_study_api_routes_are_opt_in_and_do_not_change_planplan_host(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            outputs = []
            for enabled in (False, True):
                output = root / ('enabled' if enabled else 'disabled')
                argv = ['render-config.py', '--study-cert', '/certs/study.pem', '--study-key', '/certs/study.key',
                        '--planplan-cert', '/certs/planplan.pem', '--planplan-key', '/certs/planplan.key',
                        '--planplan-root', '/opt/planplan-web-ui/current/web', '--output', str(output)]
                if enabled:
                    argv.append('--enable-study-api')
                with patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()):
                    renderer.main()
                text = (output / 'clyna-study.conf').read_text()
                review = json.loads((output / 'review.json').read_text())
                self.assertEqual(review['studyApiEnabled'], enabled)
                self.assertEqual(review['studyApiRoutes'], renderer.STUDY_API_ROUTES if enabled else {})
                self.assertEqual(review['authUpstream'], '127.0.0.1:8789')
                self.assertEqual(review['studyApiUpstream'], '127.0.0.1:8790' if enabled else None)
                self.assertEqual(renderer.STUDY_API_BEGIN in text, enabled)
                self.assertIn('client_max_body_size 16k;', text)
                self.assertIn('location ^~ /v1 { return 404; }', text)
                self.assertNotIn('@STUDY_API_LOCATIONS@', text)
                # Each exact authentication route keeps the account service;
                # enabling business routes must not change its upstream.
                for path, method in renderer.AUTH_METHODS.items():
                    auth_location = re.search(r'location = ' + re.escape(path) + r' \{\n(.*?)\n    \}', text, re.S).group(1)
                    self.assertIn(f'if ($request_method != {method}) {{ return 405; }}', auth_location)
                    self.assertIn('proxy_pass http://127.0.0.1:8789;', auth_location)
                    self.assertNotIn('127.0.0.1:8790', auth_location)
                self.assertEqual(text.count('proxy_pass http://127.0.0.1:8789;'), len(renderer.AUTH_METHODS))
                self.assertEqual(text.count('proxy_pass http://127.0.0.1:8790;'), 63 if enabled else 0)
                if enabled:
                    self.assertEqual(len(review['studyApiRoutes']), 63)
                    self.assertEqual(text.count('client_max_body_size 2m;'), 2)
                    self.assertEqual(text.count('client_max_body_size 8256k;'), 1)
                    self.assertEqual(sum(len(methods) for methods in review['studyApiRoutes'].values()), 88)
                    self.assertEqual(review['studyApiBodyLimits']['flashcardLocationBytes'], 32 * 1024)
                planplan = (output / 'clyna-planplan-alias.conf').read_bytes()
                self.assertIn(b'proxy_pass http://127.0.0.1:8789;', planplan)
                self.assertNotIn(b'127.0.0.1:8790', planplan)
                outputs.append(planplan)
            self.assertEqual(outputs[0], outputs[1])

    def test_study_api_nested_routes_are_anchored_and_methods_and_headers_are_preserved(self):
        locations = renderer.study_api_locations()
        self.assertIn('location = /v1/study/sets {', locations)
        self.assertIn('location ^~ /v1/study/ {', locations)
        self.assertIn('location ~ ^/v1/study/ { return 404; }', locations)
        patterns = re.findall(r'location ~ "([^"]+)"', locations)
        self.assertEqual(len(patterns), 53)
        uuid = '3f623e5a-1111-4111-8111-111111111111'
        base = '/v1/study/sets/' + uuid
        valid = ['/v1/study/trash/' + uuid, '/v1/study/folders/' + uuid, '/v1/study/folders/' + uuid + '/remove', '/v1/study/folders/' + uuid + '/sets', '/v1/study/folders/unfiled/sets', base + '/folder', '/v1/study/calendar/events/' + uuid, base, base + '/materials', base + '/materials/' + uuid.upper(), base + '/files', base + '/files/' + uuid + '/content',
                 base + '/generations', base + '/generations/' + uuid, base + '/generations/' + uuid + '/cancel', base + '/generations/' + uuid + '/retry',
                 base + '/chat/threads', base + '/chat/threads/' + uuid, base + '/chat/threads/' + uuid + '/messages',
                 base + '/chat/threads/' + uuid + '/messages/' + uuid + '/stop',
                 base + '/chat/threads/' + uuid + '/messages/' + uuid + '/retry',
                 base + '/chat/threads/' + uuid + '/messages/' + uuid + '/events',
                 base + '/flashcard-decks/' + uuid + '/review-queue',
                 base + '/flashcard-decks/' + uuid + '/review-sessions',
                 base + '/flashcard-decks/' + uuid + '/review-sessions/' + uuid,
                 base + '/flashcard-decks/' + uuid + '/review-sessions/' + uuid + '/actions',
                 base + '/flashcard-decks', base + '/flashcard-decks/' + uuid,
                 base + '/flashcard-decks/materialize', base + '/flashcard-decks/' + uuid + '/cards',
                 base + '/flashcard-decks/' + uuid + '/cards/' + uuid,
                 base + '/flashcard-decks/' + uuid + '/sessions',
                 base + '/flashcard-decks/' + uuid + '/sessions/' + uuid,
                 base + '/flashcard-decks/' + uuid + '/sessions/' + uuid + '/reviews',
                 base + '/plans',base + '/plans/' + uuid,base + '/plans/' + uuid + '/tasks',
                 base + '/plans/' + uuid + '/tasks/' + uuid,base + '/plans/' + uuid + '/tasks/' + uuid + '/evidence',base + '/planning-options',
                 base + '/notes',base + '/notes/' + uuid,
                 base + '/mistakes', base + '/mistakes/' + uuid + '/0',
                 base + '/mistake-reviews', base + '/mistake-reviews/' + uuid,
                 base + '/mistake-reviews/' + uuid + '/answers', base + '/mistake-reviews/' + uuid + '/submit',
                 base + '/quizzes', base + '/quizzes/' + uuid, base + '/quizzes/' + uuid + '/attempts',
                 base + '/quizzes/' + uuid + '/attempts/' + uuid,
                 base + '/quizzes/' + uuid + '/attempts/' + uuid + '/answers',
                 base + '/quizzes/' + uuid + '/attempts/' + uuid + '/submit']
        matched = set()
        for path in valid:
            indices = [i for i, pattern in enumerate(patterns) if re.fullmatch(pattern, path)]
            self.assertEqual(len(indices), 1, path)
            matched.update(indices)
        self.assertEqual(matched, set(range(len(patterns))))

        for path in [base + '/', base + '/materials/', base + '/materials/' + uuid + '/extra',
                     '/v1/study/sets/not-a-uuid', '/v1/study/sets/' + uuid[:-1],
                     '/v1/study/sets/' + uuid + 'f', '/v1/study/templates', '/v1/templates',
                     '/v1/study/sets/' + uuid.replace('-', ''), '/v1/study/sets/' + uuid.replace('3', 'g'),
                     '/v1/study/sets/' + uuid.replace('-4111-', '-0111-'),
                     '/v1/study/sets/' + uuid.replace('-8111-', '-7111-'),
                     base + '/files/' + uuid, base + '/files/content',
                     base + '/generations/', base + '/generations/not-a-uuid', base + '/generations/' + uuid + '/result',
                     base + '/generations/' + uuid + '/cancel/extra', '/v1/study/generation-usage/extra',
                     base + '/chat/threads/not-a-uuid', base + '/chat/threads/' + uuid + '/messages/' + uuid + '/events/extra',
                     base + '/flashcard-decks/', base + '/flashcard-decks/not-a-uuid',
                     base + '/flashcard-decks/materialize/extra', base + '/flashcard-decks/' + uuid + '/cards/not-a-uuid',
                     base + '/flashcard-decks/' + uuid + '/sessions/not-a-uuid',
                     base + '/flashcard-decks/' + uuid + '/sessions/' + uuid + '/reviews/extra',
                     base + '/mistakes/' + uuid + '/20',base + '/mistakes/' + uuid + '/-1',base + '/mistake-reviews/' + uuid + '/answers/extra',
                     base + '/quizzes/', base + '/quizzes/not-a-uuid', base + '/quizzes/' + uuid + '/attempts/not-a-uuid',
                     base + '/quizzes/' + uuid + '/attempts/' + uuid + '/answers/extra',
                     base + '/quizzes/' + uuid + '/attempts/' + uuid + '/submit/extra',
                     base + '/quizzes/' + uuid + '/answers']:
            self.assertFalse(any(re.fullmatch(pattern, path) for pattern in patterns), path)
        self.assertEqual(locations.count('if ($request_method !~ ^(GET|POST)$) { return 405; }'), 15)
        self.assertEqual(locations.count('if ($request_method !~ ^(GET|PATCH)$) { return 405; }'), 10)
        self.assertEqual(locations.count('if ($request_method !~ ^(GET)$) { return 405; }'), 19)
        self.assertEqual(locations.count('if ($request_method !~ ^(POST)$) { return 405; }'), 17)
        self.assertEqual(locations.count('if ($request_method !~ ^(PATCH)$) { return 405; }'), 2)
        self.assertEqual(locations.count('proxy_pass http://127.0.0.1:8790;'), 63)
        self.assertIn('location = /v1/study/generation-usage {', locations)
        self.assertIn('location = /v1/study/search {', locations)
        self.assertIn('location = /v1/study/folders {', locations)
        for path in ['settings', 'events', 'time-options', 'task-event', 'conflicts']:
            self.assertIn('location = /v1/study/calendar/' + path + ' {', locations)
        self.assertEqual(locations.count('client_max_body_size 8256k;'), 1)
        self.assertEqual(locations.count('client_max_body_size 32k;'), 13)
        self.assertEqual(locations.count('client_max_body_size 256k;'), 2)
        self.assertNotIn('client_max_body_size client_max_body_size', locations)
        self.assertNotIn('127.0.0.1:8789', locations)
        for directive in ['proxy_set_header Host $http_host;', 'proxy_set_header Origin $http_origin;',
                          'proxy_set_header X-CSRF-Token $http_x_csrf_token;',
                          'proxy_set_header X-PlanPlan-Expected-User $http_x_planplan_expected_user;',
                          'proxy_cache off;', 'proxy_no_cache 1;', 'proxy_next_upstream off;',
                          'proxy_hide_header Cache-Control;']:
            self.assertEqual(locations.count(directive), 63)

    def test_study_api_surgical_insertion_preserves_existing_config_and_guards_duplicates(self):
        original = '''server { server_name study.clyna.ai; }
server {
    server_name study.clyna.ai;
    root /custom/unchanged/current/web;
    # preserve this inspected configuration
    location ^~ /v1 { return 404; }
}
'''
        result = renderer.insert_study_api_locations(original)
        self.assertEqual(result.replace(renderer.study_api_locations() + '\n', '', 1), original)
        self.assertLess(result.index('location ^~ /v1/study/'), result.index('location ^~ /v1 {'))
        with self.assertRaises(ValueError):
            renderer.insert_study_api_locations(result)
        with self.assertRaises(ValueError):
            renderer.insert_study_api_locations(original.replace('study.clyna.ai', 'clyna.ai'))
        with self.assertRaises(ValueError):
            renderer.insert_study_api_locations(original.replace('    location ^~ /v1 { return 404; }', ''))

    def test_independent_backend_unit_checks_schema_and_constrains_service_resources(self):
        # Parse the deployed template, including repeated Environment entries.
        unit = configparser.ConfigParser(interpolation=None, strict=False)
        unit.read(DEPLOY / 'backend/studyc.service')
        service = unit['Service']
        self.assertEqual(service['User'], 'studyc')
        self.assertEqual(service['Group'], 'studyc')
        self.assertEqual(service['WorkingDirectory'], '/opt/studyc-api/current/server')
        self.assertEqual(service['EnvironmentFile'], '/etc/studyc/runtime.env')
        self.assertEqual(service['ExecStartPre'], '/usr/bin/node-24 dist/main.js check')
        self.assertEqual(service['ExecStart'], '/usr/bin/node-24 dist/main.js')
        self.assertEqual(service['Environment'], 'PORT=8790')
        self.assertEqual(service['MemoryMax'], '512M')
        self.assertEqual(service['MemorySwapMax'], '0')
        self.assertEqual(service['ProtectSystem'], 'strict')
        self.assertEqual(service['StateDirectory'], 'studyc')
        self.assertEqual(service['NoNewPrivileges'], 'true')
        self.assertEqual(service['InaccessiblePaths'], '/etc/planplan-web')
        self.assertEqual(service['LimitCORE'], '0')
        self.assertEqual(unit['Install']['WantedBy'], 'multi-user.target')
        self.assertNotIn('migrate', service['ExecStartPre'])
        self.assertNotIn('DATABASE_URL', (DEPLOY / 'backend/studyc.service').read_text())

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
