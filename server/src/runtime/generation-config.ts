import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createOpenRouterGenerationProvider, DEFAULT_OPENROUTER_MODEL, OPENROUTER_BASE_URL, providerOnlyForModel, validateProviderConfig } from '../generation/provider.js';
import type { GenerationProvider, GenerationProviderConfig } from '../generation/types.js';

/** Public, persisted routing identity. No credential or credential file is included. */
export function generationProviderConfig(env: NodeJS.ProcessEnv = process.env): GenerationProviderConfig {
  if (env.OPENROUTER_BASE_URL !== undefined && env.OPENROUTER_BASE_URL !== OPENROUTER_BASE_URL) throw new Error('Unsupported generation endpoint');
  const model = env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
  const outputMode = env.OPENROUTER_OUTPUT ?? 'compact';
  if (outputMode !== 'compact' && outputMode !== 'strict') throw new Error('Invalid generation output mode');
  const rawTimeout = env.OPENROUTER_TIMEOUT_MS ?? '60000';
  if (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) < 20000 || Number(rawTimeout) > 60000) throw new Error('Invalid generation timeout');
  const config: GenerationProviderConfig = { provider: 'openrouter', baseUrl: OPENROUTER_BASE_URL, model, outputMode,
    maxOutputTokens: 4096, timeoutMs: Number(rawTimeout), providerOnly: providerOnlyForModel(model) };
  validateProviderConfig(config); return config;
}
function credentialFromPrivateFile(path: string | undefined): string {
  if (!path || !isAbsolute(path)) throw new Error('STUDYC_AI_SECRETS_FILE must be an absolute private file');
  let fd: number | undefined;
  try {
    // O_NOFOLLOW checks the opened file, avoiding a lstat/read symlink race.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 16384 || (stat.mode & 0o027) !== 0) throw new Error();
    const bytes = Buffer.alloc(16385); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length > 16384) throw new Error();
    const values: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).join(',') !== 'OPENROUTER_API_KEY') throw new Error();
    const key = (values as Record<string, unknown>).OPENROUTER_API_KEY;
    if (typeof key !== 'string' || !/^[\x21-\x7E]{16,4096}$/.test(key)) throw new Error();
    return key;
  } catch { throw new Error('Invalid private generation secret file'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Disabled by default. Ambient OPENROUTER_API_KEY and database secrets never enable AI. */
export function generationProviderFromEnv(env: NodeJS.ProcessEnv = process.env, options: { fetch?: typeof fetch } = {}): GenerationProvider | null {
  if (env.STUDYC_AI_ENABLED === undefined || env.STUDYC_AI_ENABLED === 'false') return null;
  if (env.STUDYC_AI_ENABLED !== 'true') throw new Error('STUDYC_AI_ENABLED must be true or false');
  const config = generationProviderConfig(env);
  return createOpenRouterGenerationProvider({ config, apiKey: credentialFromPrivateFile(env.STUDYC_AI_SECRETS_FILE), fetch: options.fetch });
}
