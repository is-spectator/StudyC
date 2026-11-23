import { DEFAULT_GENERATION_POLICY, type GenerationPolicy } from '../generation/types.js';

const fields: { field: keyof GenerationPolicy; env: string; max: number }[] = [
  { field: 'userDailyRequests', env: 'STUDYC_AI_USER_DAILY_REQUESTS', max: 10000 },
  { field: 'globalDailyRequests', env: 'STUDYC_AI_GLOBAL_DAILY_REQUESTS', max: 100000 },
  { field: 'userDailyTokens', env: 'STUDYC_AI_USER_DAILY_TOKENS', max: 100000000 },
  { field: 'globalDailyTokens', env: 'STUDYC_AI_GLOBAL_DAILY_TOKENS', max: 1000000000 },
  { field: 'userActiveJobs', env: 'STUDYC_AI_USER_ACTIVE_JOBS', max: 20 },
  { field: 'globalActiveJobs', env: 'STUDYC_AI_GLOBAL_ACTIVE_JOBS', max: 1000 },
  { field: 'userConcurrency', env: 'STUDYC_AI_USER_CONCURRENCY', max: 2 },
  { field: 'globalConcurrency', env: 'STUDYC_AI_GLOBAL_CONCURRENCY', max: 4 },
  { field: 'maxAttempts', env: 'STUDYC_AI_MAX_ATTEMPTS', max: 3 },
];

/** Server-owned limits: client JSON cannot choose them. No credential access. */
export function generationPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): GenerationPolicy {
  const result = { ...DEFAULT_GENERATION_POLICY };
  for (const { field, env: name, max } of fields) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) {
      throw new Error(`Invalid ${name}`);
    }
    result[field] = Number(raw);
  }
  if (result.userDailyRequests > result.globalDailyRequests || result.userDailyTokens > result.globalDailyTokens
    || result.userActiveJobs > result.globalActiveJobs || result.userConcurrency > result.globalConcurrency
    || result.userConcurrency > result.userActiveJobs || result.globalConcurrency > result.globalActiveJobs) {
    throw new Error('Generation limits are inconsistent');
  }
  return result;
}
