import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeConfig } from '../src/runtime/config.js';

const databaseUrl = 'postgresql://studyc_fixture:fixture-password@db.example.test:5432/studyc_fixture';
const secret = 'fixture-only-rate-budget-key-1234';
// Configuration parsing only: no connection is made and no certificate is trusted.
const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-config-fixture\n-----END CERTIFICATE-----\n';

describe('independent StudyC runtime configuration', () => {
  let directory: string;
  let secretFile: string;
  let caFile: string;
  let env: NodeJS.ProcessEnv;

  function writeSecrets(values: unknown, mode = 0o600) {
    writeFileSync(secretFile, JSON.stringify(values), { mode });
    chmodSync(secretFile, mode);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'studyc-config-test-'));
    secretFile = join(directory, 'secrets.json');
    caFile = join(directory, 'pg-ca.pem');
    writeSecrets({ DATABASE_URL: databaseUrl, RATE_LIMIT_SECRET: secret });
    writeFileSync(caFile, ca, { mode: 0o600 });
    env = { STUDYC_SECRETS_FILE: secretFile, PG_CA_FILE: caFile, RELEASE_ID: 'git:fixture123' };
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it.each([0o600, 0o640])('loads the two allowed private values with mode %i and pins TLS verification', mode => {
    // Key order is not significant; authentication secrets have no place here.
    writeSecrets({ RATE_LIMIT_SECRET: secret, DATABASE_URL: databaseUrl }, mode);
    const result = runtimeConfig({ ...env, DATABASE_URL: 'pglite://memory', PGSSLMODE: 'disable' });
    expect(result).toEqual({ databaseUrl, ssl: { ca, rejectUnauthorized: true },
      rateLimitSecret: new TextEncoder().encode(secret), port: 8790, releaseId: 'git:fixture123' });
  });

  it.each([
    { DATABASE_URL: databaseUrl },
    { RATE_LIMIT_SECRET: secret },
    { DATABASE_URL: databaseUrl, RATE_LIMIT_SECRET: secret, JWT_SECRET: 'forbidden-fixture' },
    { DATABASE_URL: databaseUrl, RATE_LIMIT_SECRET: secret, COOKIE_SECRET: 'forbidden-fixture' },
    { DATABASE_URL: 123, RATE_LIMIT_SECRET: secret },
    { DATABASE_URL: databaseUrl, RATE_LIMIT_SECRET: 123 },
    {}, [], null, 'fixture', 12,
  ])('rejects an absent, extra, or non-string secret field (%#)', values => {
    writeSecrets(values);
    expect(() => runtimeConfig(env)).toThrow();
  });

  it('rejects malformed or oversized JSON before using it', () => {
    writeFileSync(secretFile, '{bad-json');
    expect(() => runtimeConfig(env)).toThrow();
    writeSecrets({ DATABASE_URL: databaseUrl, RATE_LIMIT_SECRET: 'x'.repeat(16_384) });
    expect(() => runtimeConfig(env)).toThrow('Secret file must be private');
  });

  it.each([0o660, 0o620, 0o644, 0o604, 0o601, 0o607])('rejects group-write or public file permissions %i', mode => {
    chmodSync(secretFile, mode);
    expect(() => runtimeConfig(env)).toThrow('Secret file must be private');
  });

  it('rejects a directory or symlink as the secret file', () => {
    expect(() => runtimeConfig({ ...env, STUDYC_SECRETS_FILE: directory })).toThrow('Secret file must be private');
    const link = join(directory, 'linked-secrets.json');
    symlinkSync(secretFile, link);
    expect(() => runtimeConfig({ ...env, STUDYC_SECRETS_FILE: link })).toThrow('Secret file must be private');
  });

  it('requires an explicit, present private file rather than ambient credentials', () => {
    const { STUDYC_SECRETS_FILE: _file, ...withoutFile } = env;
    expect(() => runtimeConfig({ ...withoutFile, DATABASE_URL: databaseUrl })).toThrow('STUDYC_SECRETS_FILE is required');
    expect(() => runtimeConfig({ ...env, STUDYC_SECRETS_FILE: join(directory, 'missing') })).toThrow();
  });

  it.each([
    'ssl=false', 'sslmode=disable', 'sslmode=no-verify', 'sslcert=/tmp/cert',
    'sslkey=/tmp/key', 'sslrootcert=/tmp/ca', 'sslpassword=fixture',
    'SSLMode=disable', 'ss%6cmode=disable', 'options=-c%20search_path%3Dpublic',
    '%6fptions=-c%20statement_timeout%3D0', 'sslmode=require&sslmode=disable',
  ])('rejects database URL overrides of TLS or connection options (%s)', query => {
    writeSecrets({ DATABASE_URL: databaseUrl + '?' + query, RATE_LIMIT_SECRET: secret });
    expect(() => runtimeConfig(env)).toThrow('Explicit TLS database configuration required');
  });

  it.each([
    'pglite://memory', 'http://user:password@db.example.test/studyc_fixture',
    'postgresql://db.example.test/studyc_fixture',
    'postgresql://user@db.example.test/studyc_fixture',
    'postgresql://:password@db.example.test/studyc_fixture',
    'postgresql://user:password@/studyc_fixture',
    'postgresql://user:password@db.example.test',
    'postgresql://user:password@db.example.test/',
  ])('requires explicit PostgreSQL host, database, and credentials (%#)', url => {
    writeSecrets({ DATABASE_URL: url, RATE_LIMIT_SECRET: secret });
    expect(() => runtimeConfig(env)).toThrow();
  });

  it('accepts the postgres alias without changing explicit TLS verification', () => {
    writeSecrets({ DATABASE_URL: databaseUrl.replace('postgresql:', 'postgres:'), RATE_LIMIT_SECRET: secret });
    expect(runtimeConfig(env).ssl.rejectUnauthorized).toBe(true);
  });

  it('requires a readable, non-empty CA instead of silently using no CA', () => {
    const { PG_CA_FILE: _caFile, ...withoutCa } = env;
    expect(() => runtimeConfig(withoutCa)).toThrow('PG_CA_FILE is required');
    expect(() => runtimeConfig({ ...env, PG_CA_FILE: join(directory, 'missing-ca') })).toThrow();
    for (const contents of ['', ' \n\t']) {
      writeFileSync(caFile, contents);
      expect(() => runtimeConfig(env)).toThrow('TLS CA must not be empty');
    }
  });

  it.each(['', 'x'.repeat(31), '学'.repeat(10)])('rejects a write-budget secret below 32 UTF-8 bytes (%#)', value => {
    writeSecrets({ DATABASE_URL: databaseUrl, RATE_LIMIT_SECRET: value });
    expect(() => runtimeConfig(env)).toThrow('Shared write-budget key is too short');
  });

  it('accepts exactly 32 secret bytes and measures UTF-8 bytes', () => {
    for (const value of ['x'.repeat(32), '学'.repeat(10) + 'xy']) {
      writeSecrets({ DATABASE_URL: databaseUrl, RATE_LIMIT_SECRET: value });
      expect(runtimeConfig(env).rateLimitSecret.byteLength).toBe(32);
    }
  });

  it.each(['', '0', '1023', '65536', '8790.5', 'NaN'])('rejects an invalid listener port (%s)', port => {
    expect(() => runtimeConfig({ ...env, PORT: port })).toThrow('Invalid port');
  });

  it.each(['', 'git:bad release', 'git:bad\nrelease', 'x'.repeat(129)])('rejects unsafe or absent release metadata (%#)', release => {
    expect(() => runtimeConfig({ ...env, RELEASE_ID: release })).toThrow('RELEASE_ID is required');
  });
});
