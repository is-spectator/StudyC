#!/usr/bin/env python3
"""Package an already reviewed/build-tested dist; never runs a build or SSH."""
import argparse
import gzip
import json
from pathlib import Path
import re
import tarfile

from release_lib import add_tar_file, collect, describe, digest, read_archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source-revision', default='unrecorded')
    parser.add_argument('--auth-reviewed', action='store_true', help='Operator confirms the final auth integration was reviewed and built')
    args = parser.parse_args()
    if not args.auth_reviewed:
        parser.error('Authentication integration must be reviewed before packaging')
    if args.source_revision != 'unrecorded' and not re.fullmatch(r'[0-9a-f]{7,64}', args.source_revision):
        parser.error('Source revision must be a verified Git/hash identity, or unrecorded')
    files = collect(args.dist)
    manifest = describe(files, args.source_revision)
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / f"study-{manifest['releaseSha256']}.tar.gz"
    checksum = archive.with_suffix(archive.suffix + '.sha256')
    if archive.exists() or checksum.exists():
        parser.error('Output already exists; use a fresh output directory')
    try:
        with archive.open('xb') as output:
            archive.chmod(0o600)
            with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressed:
                with tarfile.open(mode='w', fileobj=compressed, format=tarfile.USTAR_FORMAT) as bundle:
                    add_tar_file(bundle, 'release.json', (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode())
                    for name, data in sorted(files.items()):
                        add_tar_file(bundle, 'web/' + name, data)
        read_archive(archive)
        with checksum.open('x') as output:
            output.write(f'{digest(archive.read_bytes())}  {archive.name}\n')
        checksum.chmod(0o600)
    except Exception:
        archive.unlink(missing_ok=True)
        checksum.unlink(missing_ok=True)
        raise
    print(json.dumps({'archive': str(archive), 'checksum': str(checksum), 'releaseSha256': manifest['releaseSha256'], 'fileCount': manifest['fileCount'], 'builtByThisScript': False}))


if __name__ == '__main__':
    main()
