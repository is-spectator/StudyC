#!/usr/bin/env python3
"""Guarded host-local activation of Study and the shared Clyna/PlanPlan UI.

Default: read-only checks. --apply switches static files only. No SSH, backend
restart, environment/database writes, DNS, TLS, or authentication-policy edits.
Each current symlink is replaced atomically; failure restores the whole change.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
import uuid

from release_lib import digest, verify_directory

STUDY_BASE = Path('/opt/clyna-study')
UI_BASE = Path('/opt/planplan-web-ui')
BACKEND_BASE = Path('/opt/planplan-web')
OLD_ROOT = b'/opt/planplan-web/current/web'
NEW_ROOT = b'/opt/planplan-web-ui/current/web'
CONFIGS = {'clyna-study.conf': 'expected_study_config',
           'zzz-planplan-web.conf': 'expected_clyna_config',
           'clyna-planplan-alias.conf': 'expected_planplan_config'}
WRITABLE_CONFIGS = ('zzz-planplan-web.conf', 'clyna-planplan-alias.conf')


def command(args: list[str]) -> bytes:
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'{Path(args[0]).name} timed out after 30 seconds') from None
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} failed with return code {result.returncode}; inspect stderr locally')
    return result.stdout


def controlled(path: Path, directory: bool = False) -> None:
    if not path.is_absolute() or path.resolve() != path or path.is_symlink():
        raise ValueError('Expected a real absolute root-controlled path')
    info = path.stat()
    if (not path.is_dir() if directory else not path.is_file()) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
        raise ValueError('Expected root-owned paths without group/world write access')


def release_manifest(path: Path, base: Path) -> dict:
    if path.parent != base / 'releases':
        raise ValueError('Static release must be in its dedicated releases directory')
    controlled(base, True)
    controlled(base / 'releases', True)
    controlled(path, True)
    manifest = verify_directory(path)
    for item in path.rglob('*'):
        controlled(item, item.is_dir())
    return manifest


def guarded_link(link: Path, expected: str, release_parent: Path) -> str | None:
    """Check the resolved target, but retain the original link text for rollback."""
    controlled(link.parent, True)
    if expected == 'absent':
        if link.exists() or link.is_symlink():
            raise ValueError('Current symlink exists where absence was reviewed')
        return None
    target = Path(expected)
    if not target.is_absolute() or target.resolve(strict=True) != target or target.parent != release_parent:
        raise ValueError('Expected current target must be a real release in its dedicated directory')
    if not link.is_symlink() or link.lstat().st_uid != 0 or link.resolve(strict=True) != target:
        raise ValueError('Current symlink differs from the reviewed target')
    return os.readlink(link)


def replace_root(contents: bytes) -> bytes:
    """Change one application root; preserve ACME/other roots and all other bytes."""
    roots = [match for match in re.finditer(rb'(?<![\w-])root[ \t]+([^;#\r\n \t]+)[ \t]*;', contents)
             if b'#' not in contents[contents.rfind(b'\n', 0, match.start()) + 1:match.start()]]
    application_roots = [match for match in roots if match.group(1) == OLD_ROOT]
    if len(application_roots) != 1:
        raise ValueError('Expected exactly one application root pointing to the existing PlanPlan frontend')
    start, end = application_roots[0].span(1)
    return contents[:start] + NEW_ROOT + contents[end:]


def local_get(args: argparse.Namespace, domain: str, path: str) -> bytes:
    return command([args.curl_bin, '--silent', '--show-error', '--fail', '--noproxy', '*',
                    '--max-time', '15', '--resolve', f'{domain}:443:127.0.0.1', f'https://{domain}{path}'])


def backend_ready(args: argparse.Namespace) -> None:
    for domain in ('clyna.ai', 'planplan.clyna.ai'):
        ready = json.loads(local_get(args, domain, '/readyz'))
        if not isinstance(ready, dict) or ready.get('ok') is not True or ready.get('release') != args.expected_backend_release:
            raise ValueError('Existing PlanPlan backend readiness/release changed')


def check(args: argparse.Namespace) -> dict:
    if not re.fullmatch(r'source-sha256:[0-9a-f]{64}', args.expected_backend_release):
        raise ValueError('Expected the inspected full backend source-sha256 release identity')
    manifests = {'study': release_manifest(args.study_release, STUDY_BASE),
                 'planplan': release_manifest(args.planplan_ui_release, UI_BASE)}
    controlled(args.nginx_conf_dir, True)
    originals = {}
    configurations = {}
    for name, argument in CONFIGS.items():
        path = args.nginx_conf_dir / name
        controlled(path)
        contents = path.read_bytes()
        if digest(contents) != getattr(args, argument):
            raise ValueError(f'Reviewed configuration hash changed: {name}')
        info = path.stat()
        originals[name] = {'contents': contents, 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid}
        if name in WRITABLE_CONFIGS:
            configurations[name] = replace_root(contents)
    previous = {
        'study': guarded_link(STUDY_BASE / 'current', args.expected_study_current, STUDY_BASE / 'releases'),
        'planplan': guarded_link(UI_BASE / 'current', args.expected_planplan_ui_current, UI_BASE / 'releases'),
    }
    if args.expected_study_current == 'absent' or args.expected_planplan_backend_current == 'absent':
        raise ValueError('An existing Study release and backend release are required')
    guarded_link(BACKEND_BASE / 'current', args.expected_planplan_backend_current, BACKEND_BASE / 'releases')
    command([args.nginx_bin, '-t'])
    backend_ready(args)
    return {'manifests': manifests, 'originals': originals, 'configurations': configurations, 'previous': previous,
            'oldApplicationRootOccurrences': {name: originals[name]['contents'].count(OLD_ROOT) for name in WRITABLE_CONFIGS}}


def atomic_file(path: Path, data: bytes, mode: int = 0o644, uid: int = 0, gid: int = 0) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix='.registration-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, uid, gid)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def atomic_link(link: Path, target: str | Path | None) -> None:
    if target is None:
        link.unlink(missing_ok=True)
        return
    temporary = link.parent / ('.current-' + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target)
        os.replace(temporary, link)
    finally:
        temporary.unlink(missing_ok=True)


def probes(args: argparse.Namespace, review: dict) -> None:
    expected = {'study.clyna.ai': review['manifests']['study']['files']['index.html'],
                'clyna.ai': review['manifests']['planplan']['files']['index.html'],
                'planplan.clyna.ai': review['manifests']['planplan']['files']['index.html']}
    for domain, index_hash in expected.items():
        paths = ('/', '/index.html') if domain == 'study.clyna.ai' else ('/', '/index.html', '/login')
        for path in paths:
            if digest(local_get(args, domain, path)) != index_hash:
                raise ValueError(f'HTTPS frontend hash mismatch: {domain}{path}')
    if digest((args.nginx_conf_dir / 'clyna-study.conf').read_bytes()) != args.expected_study_config:
        raise ValueError('Study configuration changed during frontend activation')
    for name, contents in review['configurations'].items():
        if (args.nginx_conf_dir / name).read_bytes() != contents:
            raise ValueError('Installed frontend configuration changed')
    guarded_link(STUDY_BASE / 'current', str(args.study_release), STUDY_BASE / 'releases')
    guarded_link(UI_BASE / 'current', str(args.planplan_ui_release), UI_BASE / 'releases')
    guarded_link(BACKEND_BASE / 'current', args.expected_planplan_backend_current, BACKEND_BASE / 'releases')
    backend_ready(args)


def wait_for_probes(args: argparse.Namespace, review: dict, attempts: int = 10, delay: float = 0.5) -> None:
    """Only read-only GET/read checks are retried during graceful worker takeover."""
    for attempt in range(attempts):
        try:
            probes(args, review)
            return
        except (RuntimeError, ValueError):
            if attempt + 1 == attempts:
                raise
            time.sleep(delay)


def apply(args: argparse.Namespace) -> None:
    if os.geteuid() != 0:
        raise ValueError('Apply requires root on the inspected host')
    if not args.backup_root.is_absolute() or args.backup_root.resolve() != args.backup_root:
        raise ValueError('Backup root must be a real absolute path')
    with ExitStack() as stack:
        for base in (STUDY_BASE, UI_BASE):
            controlled(base, True)
            lock = stack.enter_context((base / '.deploy.lock').open('a'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        review = check(args)
        backup = args.backup_root / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
        backup.mkdir(parents=True, mode=0o700)
        backup.chmod(0o700)
        for name, original in review['originals'].items():
            atomic_file(backup / name, original['contents'], mode=0o600)
        journal = {'state': 'backed-up', 'studyRelease': str(args.study_release), 'planplanUIRelease': str(args.planplan_ui_release),
                   'previousLinks': review['previous'], 'expectedBackendCurrent': args.expected_planplan_backend_current,
                   'expectedBackendRelease': args.expected_backend_release, 'nginxConfDirectory': str(args.nginx_conf_dir),
                   'originals': {name: {key: value for key, value in original.items() if key != 'contents'} for name, original in review['originals'].items()},
                   'originalConfigHashes': {name: digest(original['contents']) for name, original in review['originals'].items()},
                   'installedConfigHashes': {name: digest(contents) for name, contents in review['configurations'].items()},
                   'backendChanged': False, 'databaseChanged': False}
        journal_path = backup / 'journal.json'
        atomic_file(journal_path, (json.dumps(journal, indent=2) + '\n').encode(), mode=0o600)
        print(json.dumps({'state': 'backed-up', 'backup': str(backup)}), flush=True)
        try:
            for name, contents in review['configurations'].items():
                original = review['originals'][name]
                atomic_file(args.nginx_conf_dir / name, contents, **{key: original[key] for key in ('mode', 'uid', 'gid')})
            command([args.nginx_bin, '-t'])
            atomic_link(STUDY_BASE / 'current', args.study_release)
            atomic_link(UI_BASE / 'current', args.planplan_ui_release)
            command([args.systemctl_bin, 'reload', 'nginx'])
            wait_for_probes(args, review)
            journal['state'] = 'activated-and-probed'
        except Exception:
            failures = []
            for name in WRITABLE_CONFIGS:
                try:
                    original = review['originals'][name]
                    atomic_file(args.nginx_conf_dir / name, original['contents'], **{key: original[key] for key in ('mode', 'uid', 'gid')})
                except Exception:
                    failures.append('restore-' + name)
            for name, base in (('study', STUDY_BASE), ('planplan', UI_BASE)):
                try:
                    atomic_link(base / 'current', review['previous'][name])
                except Exception:
                    failures.append('restore-' + name + '-current')
            try:
                command([args.nginx_bin, '-t'])
                command([args.systemctl_bin, 'reload', 'nginx'])
            except Exception:
                failures.append('reload-restored-nginx')
            journal.update({'state': 'rollback-failed' if failures else 'rolled-back', 'rollbackFailures': failures})
            print(json.dumps({'state': journal['state'], 'backup': str(backup), 'rollbackFailures': failures}), flush=True)
            raise
        finally:
            atomic_file(journal_path, (json.dumps(journal, indent=2) + '\n').encode(), mode=0o600)
        print(json.dumps({'state': journal['state'], 'backup': str(backup), 'backendChanged': False, 'databaseChanged': False}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--study-release', required=True, type=Path)
    parser.add_argument('--planplan-ui-release', required=True, type=Path)
    parser.add_argument('--nginx-conf-dir', required=True, type=Path)
    for option in ('expected-study-config', 'expected-clyna-config', 'expected-planplan-config', 'expected-study-current',
                   'expected-planplan-ui-current', 'expected-planplan-backend-current', 'expected-backend-release'):
        parser.add_argument('--' + option, required=True)
    parser.add_argument('--backup-root', type=Path, default=Path('/var/backups/clyna-central-registration'))
    parser.add_argument('--nginx-bin', default='/usr/sbin/nginx')
    parser.add_argument('--systemctl-bin', default='/usr/bin/systemctl')
    parser.add_argument('--curl-bin', default='/usr/bin/curl')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply:
        apply(args)
    else:
        review = check(args)
        print(json.dumps({'state': 'checked-not-installed', 'changes': False,
                          'studyReleaseSha256': review['manifests']['study']['releaseSha256'],
                          'planplanUIReleaseSha256': review['manifests']['planplan']['releaseSha256'],
                          'candidateConfigHashes': {name: digest(contents) for name, contents in review['configurations'].items()},
                          'oldApplicationRootOccurrences': review['oldApplicationRootOccurrences'],
                          'backendRelease': args.expected_backend_release, 'candidateNginxSyntax': 'pending-install-test'}))


if __name__ == '__main__':
    main()
