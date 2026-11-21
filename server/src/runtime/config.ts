import { readFileSync, lstatSync } from 'node:fs';

/** Only database access and the shared write-budget key cross the service boundary. */
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const file = env.STUDYC_SECRETS_FILE;
  if (!file) throw new Error('STUDYC_SECRETS_FILE is required');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o027) !== 0) throw new Error('Secret file must be private');
  const secrets: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new Error('Invalid secret file');
  const values = secrets as Record<string, unknown>;
  if (Object.keys(values).sort().join(',') !== 'DATABASE_URL,RATE_LIMIT_SECRET'
    || typeof values.DATABASE_URL !== 'string' || typeof values.RATE_LIMIT_SECRET !== 'string') throw new Error('Invalid secret keys');
  const url = new URL(values.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password || !url.hostname || url.pathname.length < 2
    || [...url.searchParams.keys()].some(key => /^(ssl|options)/i.test(key))) throw new Error('Explicit TLS database configuration required');
  const caFile = env.PG_CA_FILE;
  if (!caFile) throw new Error('PG_CA_FILE is required');
  const ca = readFileSync(caFile, 'utf8');
  if (!ca.trim()) throw new Error('TLS CA must not be empty');
  const rateLimitSecret = new TextEncoder().encode(values.RATE_LIMIT_SECRET);
  if (rateLimitSecret.length < 32) throw new Error('Shared write-budget key is too short');
  const port = Number(env.PORT ?? '8790');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const releaseId = env.RELEASE_ID;
  if (!releaseId || !/^[a-zA-Z0-9:._-]{1,128}$/.test(releaseId)) throw new Error('RELEASE_ID is required');
  return { databaseUrl: url.toString(), ssl: { ca, rejectUnauthorized: true as const }, rateLimitSecret, port, releaseId };
}
