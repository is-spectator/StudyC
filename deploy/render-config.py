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
STUDY_API_ROUTES = {
    '/v1/study/sets': ['GET', 'POST'],
    '/v1/study/sets/{setId}': ['GET', 'PATCH'],
    '/v1/study/sets/{setId}/materials': ['GET', 'POST'],
    '/v1/study/sets/{setId}/materials/{materialId}': ['GET', 'PATCH'],
    '/v1/study/sets/{setId}/files': ['GET', 'POST'],
    '/v1/study/sets/{setId}/files/{fileId}/content': ['GET'],
    '/v1/study/sets/{setId}/generations': ['GET', 'POST'],
    '/v1/study/sets/{setId}/generations/{jobId}': ['GET'],
    '/v1/study/sets/{setId}/generations/{jobId}/cancel': ['POST'],
    '/v1/study/sets/{setId}/generations/{jobId}/retry': ['POST'],
    '/v1/study/generation-usage': ['GET'],
    '/v1/study/search': ['GET'],
    '/v1/study/imports': ['POST'],
    '/v1/study/imports/status': ['GET'],
    '/v1/study/copies': ['POST'],
    '/v1/study/sets/{setId}/copy-preview': ['GET'],
    '/v1/study/trash': ['GET'],
    '/v1/study/trash/{setId}': ['GET', 'PATCH'],
    '/v1/study/folders': ['GET', 'POST'],
    '/v1/study/folders/{folderId}': ['GET', 'PATCH'],
    '/v1/study/folders/{folderId}/remove': ['POST'],
    '/v1/study/folders/{folderId}/sets': ['GET'],
    '/v1/study/sets/{setId}/folder': ['GET', 'PATCH'],
    '/v1/study/sets/{setId}/chat/threads': ['GET', 'POST'],
    '/v1/study/sets/{setId}/chat/threads/{threadId}': ['GET'],
    '/v1/study/sets/{setId}/chat/threads/{threadId}/messages': ['POST'],
    '/v1/study/sets/{setId}/chat/threads/{threadId}/messages/{turnId}/stop': ['POST'],
    '/v1/study/sets/{setId}/chat/threads/{threadId}/messages/{turnId}/retry': ['POST'],
    '/v1/study/sets/{setId}/chat/threads/{threadId}/messages/{turnId}/events': ['GET'],
    '/v1/study/sets/{setId}/flashcard-decks': ['GET', 'POST'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}': ['GET', 'PATCH'],
    '/v1/study/sets/{setId}/flashcard-decks/materialize': ['POST'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/cards': ['POST'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/cards/{cardId}': ['PATCH'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/sessions': ['POST'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/sessions/{sessionId}': ['GET'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/sessions/{sessionId}/reviews': ['POST'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/review-queue': ['GET'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/review-sessions': ['POST'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/review-sessions/{sessionId}': ['GET'],
    '/v1/study/sets/{setId}/flashcard-decks/{deckId}/review-sessions/{sessionId}/actions': ['POST'],
    '/v1/study/calendar/settings': ['GET', 'PATCH'],
    '/v1/study/calendar/events': ['GET', 'POST'],
    '/v1/study/calendar/events/{eventId}': ['GET', 'PATCH'],
    '/v1/study/calendar/time-options': ['GET'],
    '/v1/study/calendar/task-event': ['GET'],
    '/v1/study/calendar/conflicts': ['POST'],
    '/v1/study/sets/{setId}/plans': ['GET', 'POST'],
    '/v1/study/sets/{setId}/plans/{planId}': ['GET', 'PATCH'],
    '/v1/study/sets/{setId}/plans/{planId}/tasks': ['GET', 'POST'],
    '/v1/study/sets/{setId}/plans/{planId}/tasks/{taskId}': ['PATCH'],
    '/v1/study/sets/{setId}/plans/{planId}/tasks/{taskId}/evidence': ['GET', 'POST'],
    '/v1/study/sets/{setId}/planning-options': ['GET'],
    '/v1/study/sets/{setId}/notes': ['GET', 'POST'],
    '/v1/study/sets/{setId}/notes/{noteId}': ['GET', 'PATCH'],
    '/v1/study/sets/{setId}/mistakes': ['GET'],
    '/v1/study/sets/{setId}/mistakes/{quizId}/{questionIndex}': ['GET'],
    '/v1/study/sets/{setId}/mistake-reviews': ['GET', 'POST'],
    '/v1/study/sets/{setId}/mistake-reviews/{reviewId}': ['GET'],
    '/v1/study/sets/{setId}/mistake-reviews/{reviewId}/answers': ['POST'],
    '/v1/study/sets/{setId}/mistake-reviews/{reviewId}/submit': ['POST'],
    '/v1/study/sets/{setId}/quizzes': ['GET', 'POST'],
    '/v1/study/sets/{setId}/quizzes/{quizId}': ['GET'],
    '/v1/study/sets/{setId}/quizzes/{quizId}/attempts': ['GET', 'POST'],
    '/v1/study/sets/{setId}/quizzes/{quizId}/attempts/{attemptId}': ['GET'],
    '/v1/study/sets/{setId}/quizzes/{quizId}/attempts/{attemptId}/answers': ['POST'],
    '/v1/study/sets/{setId}/quizzes/{quizId}/attempts/{attemptId}/submit': ['POST'],
}
UUID_PATTERN = r'[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}'
STUDY_API_BEGIN = '    # BEGIN StudyC authenticated data API'
STUDY_API_END = '    # END StudyC authenticated data API'
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
# Authentication remains with the existing account service. StudyC business
# routes use the independent process, with the same request/cache safeguards.
STUDY_PROXY_DIRECTIVES = PROXY_DIRECTIVES.replace(
    'proxy_pass http://127.0.0.1:8789;', 'proxy_pass http://127.0.0.1:8790;', 1)


def study_api_locations() -> str:
    """Standalone insertion; do not regenerate unrelated live hosts/static roots.

    The longer ^~ prefix is essential: same-level regex locations would lose to
    the existing ^~ /v1 denial. Regex matching occurs inside this chosen prefix.
    The final nested regex rejects every unrecognized Study API path.
    """
    def proxy_location(selector: str, methods: list[str], indent: int, body: str = '') -> str:
        space = ' ' * indent
        directives = [f'{space}location {selector} {{',
                      f'{space}    if ($request_method !~ ^({"|".join(methods)})$) {{ return 405; }}']
        if body:
            directives.append(f'{space}    client_max_body_size {body};')
        directives.extend(space + '    ' + line.strip() for line in STUDY_PROXY_DIRECTIVES.splitlines())
        directives.append(space + '}')
        return '\n'.join(directives)

    routes = [STUDY_API_BEGIN,
              proxy_location('= /v1/study/sets', ['GET', 'POST'], 4),
              proxy_location('= /v1/study/generation-usage', ['GET'], 4),
              proxy_location('= /v1/study/search', ['GET'], 4),
              proxy_location('= /v1/study/imports', ['POST'], 4, '2m'),
              proxy_location('= /v1/study/imports/status', ['GET'], 4),
              proxy_location('= /v1/study/copies', ['POST'], 4, '32k'),
              proxy_location('= /v1/study/trash', ['GET'], 4),
              proxy_location('= /v1/study/folders', ['GET', 'POST'], 4),
              proxy_location('= /v1/study/calendar/settings', ['GET', 'PATCH'], 4),
              proxy_location('= /v1/study/calendar/events', ['GET', 'POST'], 4),
              proxy_location('= /v1/study/calendar/time-options', ['GET'], 4),
              proxy_location('= /v1/study/calendar/task-event', ['GET'], 4),
              proxy_location('= /v1/study/calendar/conflicts', ['POST'], 4),
              '    location ^~ /v1/study/ {',
              proxy_location(f'~ "^/v1/study/calendar/events/{UUID_PATTERN}$"', ['GET', 'PATCH'], 8),
              proxy_location(f'~ "^/v1/study/trash/{UUID_PATTERN}$"', ['GET', 'PATCH'], 8),
              proxy_location(f'~ "^/v1/study/folders/{UUID_PATTERN}$"', ['GET', 'PATCH'], 8),
              proxy_location(f'~ "^/v1/study/folders/{UUID_PATTERN}/remove$"', ['POST'], 8),
              proxy_location(f'~ "^/v1/study/folders/(?:{UUID_PATTERN}|unfiled)/sets$"', ['GET'], 8)]
    # 8256 KiB is an 8 MiB PDF plus the 64 KiB multipart overhead the service allows.
    for suffix, methods, body in [('', ['GET', 'PATCH'], ''),
                                   ('/copy-preview', ['GET'], ''),
                                   ('/folder', ['GET', 'PATCH'], ''),
                                   ('/materials', ['GET', 'POST'], '2m'),
                                   (f'/materials/{UUID_PATTERN}', ['GET', 'PATCH'], '2m'),
                                   ('/files', ['GET', 'POST'], '8256k'),
                                   (f'/files/{UUID_PATTERN}/content', ['GET'], ''),
                                   ('/generations', ['GET', 'POST'], ''),
                                   (f'/generations/{UUID_PATTERN}', ['GET'], ''),
                                   (f'/generations/{UUID_PATTERN}/cancel', ['POST'], ''),
                                   (f'/generations/{UUID_PATTERN}/retry', ['POST'], ''),
                                   ('/chat/threads', ['GET', 'POST'], ''),
                                   (f'/chat/threads/{UUID_PATTERN}', ['GET'], ''),
                                   (f'/chat/threads/{UUID_PATTERN}/messages', ['POST'], '32k'),
                                   (f'/chat/threads/{UUID_PATTERN}/messages/{UUID_PATTERN}/stop', ['POST'], ''),
                                   (f'/chat/threads/{UUID_PATTERN}/messages/{UUID_PATTERN}/retry', ['POST'], ''),
                                   (f'/chat/threads/{UUID_PATTERN}/messages/{UUID_PATTERN}/events', ['GET'], ''),
                                   (f'/flashcard-decks/{UUID_PATTERN}/review-queue', ['GET'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}/review-sessions', ['POST'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}/review-sessions/{UUID_PATTERN}', ['GET'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}/review-sessions/{UUID_PATTERN}/actions', ['POST'], '32k'),
                                   ('/flashcard-decks', ['GET', 'POST'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}', ['GET', 'PATCH'], '32k'),
                                   ('/flashcard-decks/materialize', ['POST'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}/cards', ['POST'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}/cards/{UUID_PATTERN}', ['PATCH'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}/sessions', ['POST'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}/sessions/{UUID_PATTERN}', ['GET'], '32k'),
                                   (f'/flashcard-decks/{UUID_PATTERN}/sessions/{UUID_PATTERN}/reviews', ['POST'], '32k'),
                                   ('/plans', ['GET', 'POST'], ''),
                                   (f'/plans/{UUID_PATTERN}', ['GET', 'PATCH'], ''),
                                   (f'/plans/{UUID_PATTERN}/tasks', ['GET', 'POST'], ''),
                                   (f'/plans/{UUID_PATTERN}/tasks/{UUID_PATTERN}', ['PATCH'], ''),
                                   (f'/plans/{UUID_PATTERN}/tasks/{UUID_PATTERN}/evidence', ['GET', 'POST'], ''),
                                   ('/planning-options', ['GET'], ''),
                                   ('/notes', ['GET', 'POST'], '256k'),
                                   (f'/notes/{UUID_PATTERN}', ['GET', 'PATCH'], '256k'),
                                   ('/mistakes', ['GET'], ''),
                                   (f'/mistakes/{UUID_PATTERN}/(?:[0-9]|1[0-9])', ['GET'], ''),
                                   ('/mistake-reviews', ['GET', 'POST'], ''),
                                   (f'/mistake-reviews/{UUID_PATTERN}', ['GET'], ''),
                                   (f'/mistake-reviews/{UUID_PATTERN}/answers', ['POST'], ''),
                                   (f'/mistake-reviews/{UUID_PATTERN}/submit', ['POST'], ''),
                                   ('/quizzes', ['GET', 'POST'], ''),
                                   (f'/quizzes/{UUID_PATTERN}', ['GET'], ''),
                                   (f'/quizzes/{UUID_PATTERN}/attempts', ['GET', 'POST'], ''),
                                   (f'/quizzes/{UUID_PATTERN}/attempts/{UUID_PATTERN}', ['GET'], ''),
                                   (f'/quizzes/{UUID_PATTERN}/attempts/{UUID_PATTERN}/answers', ['POST'], ''),
                                   (f'/quizzes/{UUID_PATTERN}/attempts/{UUID_PATTERN}/submit', ['POST'], '')]:
        pattern = f'^/v1/study/sets/{UUID_PATTERN}{suffix}$'
        # Quoting keeps the repetition braces part of the regex, not Nginx blocks.
        routes.append(proxy_location(f'~ "{pattern}"', methods, 8, body))
    routes.extend(['        location ~ ^/v1/study/ { return 404; }', '    }', STUDY_API_END])
    return '\n'.join(routes)


def insert_study_api_locations(existing: str) -> str:
    """Insert into the inspected Study-only host config, preserving all old bytes.

    Callers still verify the expected live hash, back up, nginx -t, reload and
    probe. This helper neither reads the server nor installs anything.
    """
    if STUDY_API_BEGIN in existing or STUDY_API_END in existing:
        raise ValueError('Study API locations are already present; refuse duplicate insertion')
    if re.findall(r'\bserver_name\s+([^;]+);', existing) != ['study.clyna.ai', 'study.clyna.ai']:
        raise ValueError('Expected only the existing Study HTTP and HTTPS host blocks')
    fallback = '    location ^~ /v1 { return 404; }'
    if existing.count(fallback) != 1:
        raise ValueError('Expected exactly one reviewed API denial location')
    return existing.replace(fallback, study_api_locations() + '\n' + fallback, 1)


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
    parser.add_argument('--enable-study-api', action='store_true', help='Explicitly expose the authenticated StudyC data, PDF, generation, chat, flashcard and quiz routes')
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
        'STUDY_API_LOCATIONS': study_api_locations() if args.enable_study_api else '',
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
    review.update({'authUpstream': '127.0.0.1:8789',
                   'studyApiUpstream': '127.0.0.1:8790' if args.enable_study_api else None,
                   'studyApiEnabled': args.enable_study_api,
                   'studyApiRoutes': STUDY_API_ROUTES if args.enable_study_api else {},
                   'studyApiBodyLimits': {'defaultBytes': 16 * 1024, 'materialLocationBytes': 2 * 1024 * 1024, 'flashcardLocationBytes': 32 * 1024, 'noteLocationBytes': 256 * 1024} if args.enable_study_api else {}})
    (args.output / 'review.json').write_text(json.dumps(review, indent=2) + '\n')
    (args.output / 'review.json').chmod(0o600)
    print(json.dumps({'reviewDirectory': str(args.output), 'status': review['status'], 'files': list(outputs)}))


if __name__ == '__main__':
    main()
