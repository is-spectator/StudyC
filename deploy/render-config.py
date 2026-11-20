#!/usr/bin/env python3
"""Render review files; does not install config or inspect any private key."""
import argparse
import hashlib
import json
from pathlib import Path
import re

AUTH_METHODS = {
    '/v1/auth/web/session': 'GET',
    '/v1/auth/web/email/code': 'POST',
    '/v1/auth/web/email/register': 'POST',
    '/v1/auth/web/email/login': 'POST',
    '/v1/auth/web/email/reset': 'POST',
    '/v1/me': 'GET',
    '/v1/logout': 'POST',
}
SECURITY_HEADERS = '''    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options DENY always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" always;'''
PROXY_DIRECTIVES = '''        proxy_pass http://127.0.0.1:8789;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-CSRF-Token $http_x_csrf_token;
        proxy_set_header X-PlanPlan-Expected-User $http_x_planplan_expected_user;
        proxy_set_header Connection "";
        proxy_connect_timeout 3s;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
        proxy_buffering off;
        proxy_request_buffering on;
        proxy_cache off;
        proxy_no_cache 1;
        proxy_cache_bypass 1;
        proxy_next_upstream off;
        proxy_hide_header Cache-Control;'''


def safe_path(value: str) -> str:
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in Path(value).parts or 'REPLACE' in value:
        raise ValueError('Use a confirmed absolute path without spaces or Nginx metacharacters')
    return value


def render(values: dict[str, str], template: str) -> str:
    result = template
    for key, value in values.items():
        result = result.replace('@' + key + '@', value)
    if re.search(r'@[A-Z_]+@', result):
        raise ValueError('Unresolved template placeholder')
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['study-cert', 'study-key', 'planplan-cert', 'planplan-key', 'planplan-root']:
        parser.add_argument('--' + name, required=True, type=safe_path)
    parser.add_argument('--acme-webroot', type=safe_path, help='Optional, only after confirming the real renewal webroot')
    parser.add_argument('--trusted-proxy-include', type=safe_path, help='Optional audited host-scoped Cloudflare real-IP snippet; never a global include')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Use a new review directory; never overwrite an existing rendered candidate')
    values = {name.upper(): value for name, value in vars(args).items() if isinstance(value, str)}
    values.update({
        'SECURITY_HEADERS': SECURITY_HEADERS,
        'PROXY_DIRECTIVES': PROXY_DIRECTIVES,
        'TRUSTED_PROXY_INCLUDE': f'    include {args.trusted_proxy_include};' if args.trusted_proxy_include else '',
        'ACME_LOCATION': f'    location ^~ /.well-known/acme-challenge/ {{ root {args.acme_webroot}; }}' if args.acme_webroot else '',
        'AUTH_LOCATIONS': '\n'.join(f'    location = {path} {{\n        if ($request_method != {method}) {{ return 405; }}\n{PROXY_DIRECTIVES}\n    }}' for path, method in AUTH_METHODS.items()),
    })
    directory = Path(__file__).parent / 'nginx'
    outputs = {
        'clyna-study.conf': render(values, (directory / 'study.conf.in').read_text()),
        'clyna-planplan-alias.conf': render(values, (directory / 'planplan-alias.conf.in').read_text()),
    }
    args.output.mkdir(parents=True, mode=0o700)
    for name, text in outputs.items():
        (args.output / name).write_text(text)
        (args.output / name).chmod(0o600)
    review = {'status': 'rendered-not-installed', 'domains': ['study.clyna.ai', 'planplan.clyna.ai'], 'upstream': '127.0.0.1:8789', 'studyAuthRoutes': AUTH_METHODS, 'files': {name: hashlib.sha256(text.encode()).hexdigest() for name, text in outputs.items()}, 'certificateFilesChecked': False, 'nginxSyntaxChecked': False, 'existingClynaConfigurationModified': False, 'proxyMode': 'audited-host-include' if args.trusted_proxy_include else 'direct-origin'}
    (args.output / 'review.json').write_text(json.dumps(review, indent=2) + '\n')
    (args.output / 'review.json').chmod(0o600)
    print(json.dumps({'reviewDirectory': str(args.output), 'status': review['status'], 'files': list(outputs)}))


if __name__ == '__main__':
    main()
