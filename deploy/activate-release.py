#!/usr/bin/env python3
"""Host-local Study activation. Default is read-only checks; --apply is explicit.

Does not SSH, edit PlanPlan runtime/DB, issue certificates, or change DNS.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
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

BASE = Path('/opt/clyna-study')
TARGETS = {'clyna-study.conf': 'study.clyna.ai', 'clyna-planplan-alias.conf': 'planplan.clyna.ai'}


def command(args: list[str]) -> bytes:
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'{Path(args[0]).name} timed out after 30 seconds') from None
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} check failed with return code {result.returncode}; inspect locally without publishing stderr, configuration, or headers')
    return result.stdout


def atomic_file(path: Path, data: bytes, mode: int = 0o644, uid: int = 0, gid: int = 0) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix='.study-deploy-', dir=path.parent)
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


def atomic_link(target: Path) -> None:
    temporary = BASE / ('.current-' + uuid.uuid4().hex)
    try:
        temporary.symlink_to(target)
        os.replace(temporary, BASE / 'current')
    finally:
        temporary.unlink(missing_ok=True)


def current_target() -> str | None:
    current = BASE / 'current'
    if not current.exists() and not current.is_symlink():
        return None
    if not current.is_symlink():
        raise ValueError('Refusing to replace a non-symlink Study current path')
    target = current.resolve(strict=True)
    if target.parent != BASE / 'releases' or not re.fullmatch(r'[0-9a-f]{64}', target.name):
        raise ValueError('Unexpected existing Study release target')
    verify_directory(target)
    return str(target)


def check(args: argparse.Namespace) -> tuple[dict, dict[str, bytes], str | None]:
    release = args.release
    if not release.is_absolute() or release.resolve() != release or release.parent != BASE / 'releases':
        raise ValueError('Release must be a real /opt/clyna-study/releases/<sha> directory')
    manifest = verify_directory(release)
    for path in [release, *release.rglob('*')]:
        info = path.lstat()
        if path.is_symlink() or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError('Release files must be root-owned, non-symlinks, and not group/world writable')
    if args.nginx_conf_dir.resolve() != args.nginx_conf_dir or not args.nginx_conf_dir.is_dir():
        raise ValueError('Use the inspected real Nginx include directory')
    directory_info = args.nginx_conf_dir.stat()
    if directory_info.st_uid != 0 or stat.S_IMODE(directory_info.st_mode) & 0o022:
        raise ValueError('Nginx include directory must be root-controlled')
    review = json.loads((args.rendered / 'review.json').read_text())
    if set(review['files']) != set(TARGETS):
        raise ValueError('Expected exactly the two new host configurations')
    configurations: dict[str, bytes] = {}
    for name, domain in TARGETS.items():
        candidate = args.rendered / name
        if candidate.is_symlink():
            raise ValueError('Rendered files must not be symlinks')
        if candidate.stat().st_uid != 0 or stat.S_IMODE(candidate.stat().st_mode) & 0o022:
            raise ValueError('Rendered host configuration must be root-owned and not group/world writable')
        contents = candidate.read_bytes()
        if digest(contents) != review['files'][name]:
            raise ValueError('Rendered config changed after review manifest creation')
        text = contents.decode()
        if re.findall(r'\bserver_name\s+([^;]+);', text) != [domain, domain]:
            raise ValueError('Configuration must declare only its confirmed new host')
        for certificate in re.findall(r'\bssl_certificate(?:_key)?\s+([^;]+);', text):
            if not Path(certificate).is_file():
                raise ValueError('An explicit certificate/key path is not installed')
        target = args.nginx_conf_dir / name
        expected = args.expected_study_config if name == 'clyna-study.conf' else args.expected_planplan_config
        actual = digest(target.read_bytes()) if target.is_file() and not target.is_symlink() else 'absent'
        if target.is_symlink() or (target.exists() and not target.is_file()) or expected != actual:
            raise ValueError('Existing destination differs from the reviewed expected hash/absence')
        configurations[name] = contents
    for path in args.nginx_conf_dir.glob('*.conf'):
        if path.name in TARGETS or not path.is_file():
            continue
        names = re.findall(r'\bserver_name\s+([^;]+);', path.read_text(errors='replace'))
        if any(domain in declaration.split() for declaration in names for domain in TARGETS.values()):
            raise ValueError('Another config in this include directory already declares a new host')
    previous = current_target()
    command([args.nginx_bin, '-t'])
    return manifest, configurations, previous


def local_get(args: argparse.Namespace, domain: str, path: str, status_only: bool = False) -> bytes:
    request = [args.curl_bin, '--silent', '--show-error', '--noproxy', '*', '--max-time', '15', '--resolve', f'{domain}:443:127.0.0.1']
    if status_only:
        request += ['--output', '/dev/null', '--write-out', '%{http_code}']
    else:
        request += ['--fail']
    return command(request + [f'https://{domain}{path}'])


def probes(args: argparse.Namespace, manifest: dict, configurations: dict[str, bytes]) -> None:
    if digest(local_get(args, 'study.clyna.ai', '/index.html')) != manifest['files']['index.html']:
        raise ValueError('Study HTTPS index does not match the selected release')
    alias = configurations['clyna-planplan-alias.conf'].decode()
    roots = re.findall(r'^    root\s+([^;]+);', alias, re.M)
    if len(roots) != 1 or digest(local_get(args, 'planplan.clyna.ai', '/index.html')) != digest((Path(roots[0]) / 'index.html').read_bytes()):
        raise ValueError('PlanPlan alias does not serve the inspected existing frontend')
    if json.loads(local_get(args, 'planplan.clyna.ai', '/readyz')).get('ok') is not True:
        raise ValueError('Existing PlanPlan upstream is not ready through the alias')
    expected = {'/v1/auth/web/session': b'401', '/v1/me': b'401', '/v1/templates': b'404', '/v1/auth/web/email/login': b'405'}
    for path, status in expected.items():
        if local_get(args, 'study.clyna.ai', path, True) != status:
            raise ValueError('Study anonymous/method/API-boundary probe failed')


def wait_for_probes(args: argparse.Namespace, manifest: dict, configurations: dict[str, bytes], attempts: int = 10, delay: float = 0.5) -> None:
    """Retry anonymous GET checks while graceful-reload workers take over.

    No mutations, configuration writes, reloads, or authenticated requests are
    retried. Each GET retains its existing request timeout; failure after the
    final attempt propagates to the unchanged rollback transaction.
    """
    for attempt in range(attempts):
        try:
            probes(args, manifest, configurations)
            return
        except (RuntimeError, ValueError):
            if attempt == attempts - 1:
                raise
            time.sleep(delay)


def apply(args: argparse.Namespace) -> None:
    if os.geteuid() != 0 or not args.confirmed_host_review or not args.origins_reviewed:
        raise ValueError('Apply requires root plus explicit host/config and additive-origin review')
    if not BASE.is_dir():
        raise ValueError('Create and inspect the dedicated Study deployment root first')
    if not args.backup_root.is_absolute() or args.backup_root.resolve() != args.backup_root:
        raise ValueError('Backup root must be a real absolute path')
    with (BASE / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, configurations, previous = check(args)
        backup = args.backup_root / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
        backup.mkdir(parents=True, mode=0o700)
        backup.chmod(0o700)
        originals: dict[str, dict | None] = {}
        for name in TARGETS:
            target = args.nginx_conf_dir / name
            if target.exists():
                metadata = target.stat()
                (backup / name).write_bytes(target.read_bytes())
                (backup / name).chmod(0o600)
                originals[name] = {'mode': stat.S_IMODE(metadata.st_mode), 'uid': metadata.st_uid, 'gid': metadata.st_gid}
            else:
                originals[name] = None
        journal = {'release': str(args.release), 'previousStudyCurrent': previous, 'nginxConfDirectory': str(args.nginx_conf_dir), 'originals': originals, 'installedConfigHashes': {name: digest(contents) for name, contents in configurations.items()}, 'state': 'backed-up', 'planplanRuntimeChanged': False, 'databaseChanged': False}
        (backup / 'journal.json').write_text(json.dumps(journal, indent=2) + '\n')
        print(json.dumps({'state': 'backed-up', 'backup': str(backup)}), flush=True)
        changed = False
        try:
            changed = True
            for name, contents in configurations.items():
                atomic_file(args.nginx_conf_dir / name, contents)
            command([args.nginx_bin, '-t'])
            atomic_link(args.release)
            command([args.systemctl_bin, 'reload', 'nginx'])
            wait_for_probes(args, manifest, configurations)
            journal['state'] = 'activated-and-probed'
        except Exception:
            failures = []
            if changed:
                for name, metadata in originals.items():
                    try:
                        if metadata is None:
                            (args.nginx_conf_dir / name).unlink(missing_ok=True)
                        else:
                            atomic_file(args.nginx_conf_dir / name, (backup / name).read_bytes(), **metadata)
                    except Exception:
                        failures.append('restore-' + name)
                try:
                    if previous:
                        atomic_link(Path(previous))
                    else:
                        (BASE / 'current').unlink(missing_ok=True)
                except Exception:
                    failures.append('restore-current')
                try:
                    command([args.nginx_bin, '-t'])
                    command([args.systemctl_bin, 'reload', 'nginx'])
                except Exception:
                    failures.append('reload-restored-nginx')
            journal.update({'state': 'rollback-failed' if failures else 'rolled-back', 'rollbackFailures': failures})
            print(json.dumps({'state': journal['state'], 'backup': str(backup), 'rollbackFailures': failures}), flush=True)
            raise
        finally:
            (backup / 'journal.json').write_text(json.dumps(journal, indent=2) + '\n')
        print(json.dumps({'state': journal['state'], 'releaseSha256': manifest['releaseSha256'], 'backup': str(backup), 'databaseChanged': False}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--rendered', required=True, type=Path)
    parser.add_argument('--nginx-conf-dir', required=True, type=Path)
    parser.add_argument('--expected-study-config', default='absent', help='SHA256 of the reviewed existing destination, or absent')
    parser.add_argument('--expected-planplan-config', default='absent', help='SHA256 of the reviewed existing destination, or absent')
    parser.add_argument('--nginx-bin', default='/usr/sbin/nginx')
    parser.add_argument('--systemctl-bin', default='/usr/bin/systemctl')
    parser.add_argument('--curl-bin', default='/usr/bin/curl')
    parser.add_argument('--backup-root', type=Path, default=Path('/var/backups/clyna-study'))
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirmed-host-review', action='store_true', help='Operator inspected included config, domains, TLS/renewal, and proxy mode')
    parser.add_argument('--origins-reviewed', action='store_true', help='Operator merged both origins without dropping existing values and validated PlanPlan')
    args = parser.parse_args()
    if args.apply:
        apply(args)
    else:
        manifest, _, previous = check(args)
        print(json.dumps({'state': 'checked-not-installed', 'releaseSha256': manifest['releaseSha256'], 'previousStudyCurrent': previous, 'existingNginxSyntax': 'passed', 'candidateNginxSyntax': 'pending-install-test', 'tlsHostnameAndBrowserAuth': 'pending', 'changes': False}))


if __name__ == '__main__':
    main()
