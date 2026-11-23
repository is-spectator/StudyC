import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERATION_POLICY } from '../src/generation/types.js';
import { generationPolicyFromEnv } from '../src/runtime/generation-policy.js';

describe('server generation budgets', () => {
  it('uses bounded defaults and isolates returned policy from the shared defaults', () => {
    const value = generationPolicyFromEnv({});
    expect(value).toEqual(DEFAULT_GENERATION_POLICY);
    value.globalDailyTokens = 1;
    expect(generationPolicyFromEnv({}).globalDailyTokens).toBe(1_000_000);
  });
  it.each(['', '0', '-1', '1.5', 'NaN', ' 20 ', '10001', '999999999999999999'])('rejects invalid request limits %s', value => {
    expect(() => generationPolicyFromEnv({ STUDYC_AI_USER_DAILY_REQUESTS: value })).toThrow();
  });
  it('rejects limits that allow one owner to exceed the global budget or concurrency', () => {
    expect(() => generationPolicyFromEnv({ STUDYC_AI_GLOBAL_DAILY_REQUESTS: '1' })).toThrow();
    expect(() => generationPolicyFromEnv({ STUDYC_AI_GLOBAL_DAILY_TOKENS: '1' })).toThrow();
    expect(() => generationPolicyFromEnv({ STUDYC_AI_USER_CONCURRENCY: '2', STUDYC_AI_GLOBAL_CONCURRENCY: '1' })).toThrow();
    expect(() => generationPolicyFromEnv({ STUDYC_AI_USER_ACTIVE_JOBS: '1', STUDYC_AI_USER_CONCURRENCY: '2' })).toThrow();
  });
  it('accepts explicit bounded operating limits without changing provider settings', () => {
    expect(generationPolicyFromEnv({ STUDYC_AI_USER_DAILY_REQUESTS: '10', OPENROUTER_API_KEY: 'not-a-config-input' }).userDailyRequests).toBe(10);
  });
});
