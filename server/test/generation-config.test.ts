import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generationProviderConfig, generationProviderFromEnv } from '../src/runtime/generation-config.js';
import { runtimeConfig } from '../src/runtime/config.js';

const key = 'fixture-only-openrouter-key-never-live';
describe('isolated generation configuration', () => {
  let directory: string, path: string, env: NodeJS.ProcessEnv;
  const write = (value: unknown, mode = 0o600) => { writeFileSync(path, JSON.stringify(value), { mode }); chmodSync(path, mode); };
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'studyc-generation-config-')); path = join(directory, 'ai-secrets.json'); write({ OPENROUTER_API_KEY: key }); env = { STUDYC_AI_ENABLED: 'true', STUDYC_AI_SECRETS_FILE: path }; });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('defaults AI off and ignores ambient provider credentials without touching a secret file', () => {
    const fetch = vi.fn(); expect(generationProviderFromEnv({ OPENROUTER_API_KEY: key, STUDYC_AI_SECRETS_FILE: '/nonexistent' }, { fetch })).toBeNull();
    expect(generationProviderFromEnv({ ...env, STUDYC_AI_ENABLED: 'false' }, { fetch })).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it('defaults the public persisted identity to the reviewed PlanPlan model/profile', () => {
    expect(generationProviderConfig({})).toEqual({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'baidu/ernie-5.5-flash-preview:free', outputMode: 'compact', maxOutputTokens: 4096, timeoutMs: 60000, providerOnly: ['baidu'] });
  });
  it.each([0o600, 0o640])('opens a private regular AI-only JSON file with mode %i and does not serialize its key', mode => {
    write({ OPENROUTER_API_KEY: key }, mode); const transport = vi.fn(); const provider = generationProviderFromEnv(env, { fetch: transport });
    expect(provider?.config).toEqual(generationProviderConfig({})); expect(JSON.stringify(provider)).not.toContain(key); expect(transport).not.toHaveBeenCalled();
  });
  it('accepts explicit supported non-secret configuration without mutating environment secrets', () => {
    const original = { ...env, OPENROUTER_MODEL: 'baidu/reviewed-model', OPENROUTER_OUTPUT: 'strict', OPENROUTER_TIMEOUT_MS: '20000', DATABASE_URL: 'private-database-value', RATE_LIMIT_SECRET: 'private-rate-value' };
    const copy = { ...original }; const result = generationProviderFromEnv(original);
    expect(result?.config).toMatchObject({ model: 'baidu/reviewed-model', outputMode: 'strict', timeoutMs: 20000, providerOnly: ['baidu'] }); expect(original).toEqual(copy);
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it.each(['', '1', 'yes', 'TRUE'])('requires an explicit true/false switch (%s)', value => { expect(() => generationProviderFromEnv({ ...env, STUDYC_AI_ENABLED: value })).toThrow('STUDYC_AI_ENABLED'); });
  it.each(['https://example.test/api/v1', 'http://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/', 'https://openrouter.ai@evil.test/api/v1', 'https://openrouter.ai/api/v1?x=1'])('rejects an unreviewed endpoint (%s)', baseUrl => { expect(() => generationProviderConfig({ OPENROUTER_BASE_URL: baseUrl })).toThrow('Unsupported generation endpoint'); });
  it.each(['nvidia/nemotron-3.5-lightning:free', 'nvidia/nemotron-3.5-super-vl:free', 'openrouter/auto', 'openrouter/free', ' model', '', 'model?token=private'])('rejects synthetic-only/dynamic or malformed model routing (%s)', model => { expect(() => generationProviderConfig({ OPENROUTER_MODEL: model })).toThrow(); });
  it.each(['0', '19999', '60001', '1000.5', '-1', 'NaN', ''])('validates the production timeout (%s)', timeout => { expect(() => generationProviderConfig({ OPENROUTER_TIMEOUT_MS: timeout })).toThrow('Invalid generation timeout'); });
  it('rejects an unrecognized output mode rather than silently selecting compact', () => { expect(() => generationProviderConfig({ OPENROUTER_OUTPUT: 'json-ish' })).toThrow('Invalid generation output mode'); });
  it('never falls back to ambient API keys or the original database secret file', () => {
    expect(() => generationProviderFromEnv({ STUDYC_AI_ENABLED: 'true', OPENROUTER_API_KEY: key })).toThrow('STUDYC_AI_SECRETS_FILE');
    expect(() => generationProviderFromEnv({ ...env, STUDYC_AI_SECRETS_FILE: 'relative.json' })).toThrow('absolute private file');
    write({ DATABASE_URL: 'private-url', RATE_LIMIT_SECRET: 'private-rate-key' }); expect(() => generationProviderFromEnv(env)).toThrow('Invalid private generation secret file');
  });
  it.each([{ OPENROUTER_API_KEY: key, DATABASE_URL: 'do-not-load' }, { OPENROUTER_API_KEY: key, RATE_LIMIT_SECRET: 'do-not-load' }, { OPENROUTER_API_KEY: 12 }, { OPENROUTER_API_KEY: '' }, {}, [], null])('rejects missing/extra secret keys (%#)', values => { write(values); expect(() => generationProviderFromEnv(env)).toThrow('Invalid private generation secret file'); });
  it.each([0o644, 0o660, 0o620, 0o604, 0o777])('rejects non-private file mode %i', mode => { chmodSync(path, mode); expect(() => generationProviderFromEnv(env)).toThrow('Invalid private generation secret file'); });
  it('rejects symlinks, directories, and unreadable/missing files with sanitized errors', () => {
    const link = join(directory, 'link.json'); symlinkSync(path, link);
    for (const candidate of [link, directory, join(directory, 'not-found')]) {
      expect(() => generationProviderFromEnv({ ...env, STUDYC_AI_SECRETS_FILE: candidate })).toThrow('Invalid private generation secret file');
      try { generationProviderFromEnv({ ...env, STUDYC_AI_SECRETS_FILE: candidate }); } catch (e) { expect(String(e)).not.toContain(candidate); }
    }
  });
  it('does not include malformed secret contents in an error', () => {
    writeFileSync(path, `{"OPENROUTER_API_KEY":"${key}"`);
    try { generationProviderFromEnv(env); throw new Error('expected failure'); } catch (e) { expect(String(e)).toBe('Error: Invalid private generation secret file'); expect(String(e)).not.toContain(key); }
    write({ OPENROUTER_API_KEY: 'x'.repeat(17000) }); expect(() => generationProviderFromEnv(env)).toThrow('Invalid private generation secret file');
  });
  it('leaves the original database/rate-limit secret contract unchanged', () => {
    const database = join(directory, 'database.json'), ca = join(directory, 'ca.pem');
    writeFileSync(database, JSON.stringify({ DATABASE_URL: 'postgresql://fixture:password@db.example.test/studyc', RATE_LIMIT_SECRET: 'synthetic-rate-limit-secret-32bytes' }), { mode: 0o600 });
    writeFileSync(ca, 'test-only-ca');
    const combined = { ...env, STUDYC_SECRETS_FILE: database, PG_CA_FILE: ca, RELEASE_ID: 'git:fixture' };
    expect(runtimeConfig(combined).databaseUrl).toContain('db.example.test'); expect(generationProviderFromEnv(combined)).not.toBeNull();
    writeFileSync(database, JSON.stringify({ DATABASE_URL: 'postgresql://fixture:password@db.example.test/studyc', RATE_LIMIT_SECRET: 'synthetic-rate-limit-secret-32bytes', OPENROUTER_API_KEY: key }));
    expect(() => runtimeConfig(combined)).toThrow('Invalid secret keys');
  });
});
