"""Static-only release format. No build, SSH, secrets, or service operations."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile

MAX_BYTES = 128 * 1024 * 1024
MAX_FILES = 5000
EXTENSIONS = {'.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.txt', '.json', '.webmanifest', '.mp3', '.wav', '.ogg', '.mp4', '.webm'}


def static_path(name: str) -> str:
    path = PurePosixPath(name)
    if not name or name != str(path) or path.is_absolute() or '\\' in name or ':' in name or '\x00' in name:
        raise ValueError('Invalid static path')
    if any(part.startswith('.') or part in {'', '..'} for part in path.parts):
        raise ValueError('Hidden or traversing static path')
    if path.suffix.lower() not in EXTENSIONS:
        raise ValueError('Unexpected static file extension')
    if re.search(r'(?:^|[-_.])(secret|credentials?|private|passwords?)(?:[-_.]|$)', path.name, re.I):
        raise ValueError('Sensitive-looking file name in static build')
    return name


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def describe(files: dict[str, bytes], revision: str = 'unrecorded') -> dict:
    if not files or len(files) > MAX_FILES or 'index.html' not in files:
        raise ValueError('Expected a bounded Vite build containing index.html')
    if sum(map(len, files.values())) > MAX_BYTES:
        raise ValueError('Static build exceeds size limit')
    hashes = {static_path(name): digest(data) for name, data in sorted(files.items())}
    identity = json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()
    return {'format': 1, 'releaseSha256': digest(identity), 'sourceRevision': revision, 'fileCount': len(files), 'totalBytes': sum(map(len, files.values())), 'files': hashes}


def collect(dist: Path) -> dict[str, bytes]:
    if not dist.is_dir() or dist.is_symlink():
        raise ValueError('Build input must be a real directory')
    files: dict[str, bytes] = {}
    total = 0
    for path in sorted(dist.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlinks are not allowed in static releases')
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('Special files are not allowed')
        name = static_path(path.relative_to(dist).as_posix())
        total += path.stat().st_size
        if total > MAX_BYTES or len(files) >= MAX_FILES:
            raise ValueError('Static build exceeds limits')
        data = path.read_bytes()
        if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:or-v1-)?[A-Za-z0-9]{32,}', data):
            raise ValueError('Possible private credential in static build; inspect locally')
        files[name] = data
    describe(files)
    return files


def read_archive(archive: Path) -> tuple[dict, dict[str, bytes]]:
    files: dict[str, bytes] = {}
    manifest = None
    names: set[str] = set()
    total = 0
    with tarfile.open(archive, 'r:gz') as bundle:
        for entry in bundle:
            if not entry.isfile() or entry.name in names or entry.size < 0:
                raise ValueError('Archive requires unique ordinary files only')
            names.add(entry.name)
            total += entry.size
            if total > MAX_BYTES + 4 * 1024 * 1024 or len(names) > MAX_FILES + 1:
                raise ValueError('Archive exceeds limits')
            if entry.name == 'release.json':
                if entry.size > 4 * 1024 * 1024:
                    raise ValueError('Manifest exceeds size limit')
            elif not entry.name.startswith('web/'):
                raise ValueError('Unexpected archive member')
            else:
                static_path(entry.name[4:])
            stream = bundle.extractfile(entry)
            if stream is None:
                raise ValueError('Unreadable archive member')
            data = stream.read(entry.size + 1)
            if len(data) != entry.size:
                raise ValueError('Archive member length mismatch')
            if entry.name == 'release.json':
                manifest = json.loads(data)
            else:
                files[entry.name[4:]] = data
    if not isinstance(manifest, dict) or manifest.get('format') != 1:
        raise ValueError('Missing or unsupported release manifest')
    calculated = describe(files, manifest.get('sourceRevision', 'unrecorded'))
    if manifest != calculated:
        raise ValueError('Release manifest or artifact digest mismatch')
    return manifest, files


def verify_directory(release: Path) -> dict:
    if release.is_symlink() or not release.is_dir():
        raise ValueError('Release must be an immutable real directory')
    manifest = json.loads((release / 'release.json').read_text())
    actual = describe(collect(release / 'web'), manifest.get('sourceRevision', 'unrecorded'))
    if manifest != actual or release.name != actual['releaseSha256']:
        raise ValueError('Release directory does not match its manifest/name')
    return actual


def add_tar_file(bundle: tarfile.TarFile, name: str, data: bytes) -> None:
    entry = tarfile.TarInfo(name)
    entry.size = len(data)
    entry.mode = 0o644
    entry.uid = entry.gid = entry.mtime = 0
    entry.uname = entry.gname = ''
    bundle.addfile(entry, io.BytesIO(data))
