import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('reopens queued/running generation state across three processes without redispatching an uncertain call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studyc-generation-persistence-'));
  const child = fileURLToPath(new URL('./fixtures/generation-persistence-child.ts', import.meta.url));
  const env = { ...process.env };
  delete env.DATABASE_URL; delete env.TEST_DATABASE_URL; delete env.STUDYC_SECRETS_FILE; delete env.STUDYC_AI_SECRETS_FILE;
  const run = promisify(execFile);
  const invoke = async (mode: string, input?: unknown) => JSON.parse((await run(process.execPath,
    ['--import', 'tsx', child, mode, join(directory, 'db'), ...(input ? [JSON.stringify(input)] : [])], { env, timeout: 30_000 })).stdout.trim());
  try {
    const written = await invoke('write'); expect(written.status).toBe('queued');
    const claimed = await invoke('claim', written); expect(claimed.status).toBe('running');
    const recovered = await invoke('recover', claimed);
    expect(new Set([written.processId, claimed.processId, recovered.processId]).size).toBe(3);
    expect(recovered).toMatchObject({ status: 'interrupted', errorCode: 'lease_expired', attemptCount: 1, usageState: 'unknown',
      snapshotBody: 'A persisted task keeps the original source across process restarts.' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 95_000);
