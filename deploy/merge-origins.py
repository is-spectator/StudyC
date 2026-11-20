#!/usr/bin/env python3
"""Read only WEB_ALLOWED_ORIGINS; output a merged review fragment, never edit runtime.env."""
import argparse
from pathlib import Path
import re
from urllib.parse import urlsplit

ADDITIONS = ['https://study.clyna.ai', 'https://planplan.clyna.ai']


def merge(text: str) -> str:
    matches = re.findall(r'^WEB_ALLOWED_ORIGINS=(.*)$', text, re.M)
    if len(matches) != 1:
        raise ValueError('Expected exactly one existing WEB_ALLOWED_ORIGINS assignment; inspect configuration ownership')
    raw = matches[0].strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'\"', "'"}:
        raw = raw[1:-1]
    origins = [entry.strip() for entry in raw.split(',') if entry.strip()]
    if not origins:
        raise ValueError('Refusing to replace an empty/unconfirmed origin configuration')
    for origin in origins:
        parsed = urlsplit(origin)
        if not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?', origin) or parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or any(c.isspace() for c in origin):
            raise ValueError('Unexpected existing origin; inspect manually without dropping values')
    merged = list(dict.fromkeys(origins + ADDITIONS))
    return 'WEB_ALLOWED_ORIGINS=' + ','.join(merged) + '\n'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-env', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        parser.error('Review fragment must be a new file')
    result = merge(args.runtime_env.read_text())
    with args.output.open('x') as output:
        output.write(result)
    args.output.chmod(0o600)
    print('Created non-secret origin review fragment; live runtime configuration was not modified.')


if __name__ == '__main__':
    main()
