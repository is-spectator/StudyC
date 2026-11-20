#!/usr/bin/env python3
"""Validate a release. Extraction requires an explicit new destination."""
import argparse
import json
from pathlib import Path
import shutil

from release_lib import read_archive, verify_directory


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--extract-to', type=Path, help='Explicit new directory named by the verified artifact SHA256')
    args = parser.parse_args()
    manifest, files = read_archive(args.archive)
    if args.extract_to:
        target = args.extract_to
        if target.exists() or target.is_symlink() or target.name != manifest['releaseSha256'] or not target.is_absolute():
            parser.error('Extraction requires a new absolute directory named by the release hash')
        target.mkdir(mode=0o755, parents=False)
        try:
            (target / 'web').mkdir(mode=0o755)
            for name, data in files.items():
                path = target / 'web' / name
                path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o644)
            (target / 'release.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
            (target / 'release.json').chmod(0o644)
            verify_directory(target)
        except Exception:
            shutil.rmtree(target)
            raise
    print(json.dumps({'verified': True, 'releaseSha256': manifest['releaseSha256'], 'fileCount': manifest['fileCount'], 'extracted': str(args.extract_to) if args.extract_to else None}))


if __name__ == '__main__':
    main()
