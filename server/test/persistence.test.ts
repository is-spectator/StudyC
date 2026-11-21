import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('restores API-created text across independent processes and a disk database reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studyc-independent-persistence-'));
  const child = fileURLToPath(new URL('./fixtures/study-persistence-child.ts', import.meta.url));
  const env = { ...process.env };
  delete env.DATABASE_URL; delete env.TEST_DATABASE_URL; delete env.STUDYC_SECRETS_FILE;
  const run = promisify(execFile);
  try {
    const written = await run(process.execPath, ['--import', 'tsx', child, 'write', join(dir, 'db')], { env, timeout: 30_000 });
    const created = JSON.parse(written.stdout.trim());
    const read = await run(process.execPath, ['--import', 'tsx', child, 'read', join(dir, 'db'), created.userId, created.setId, created.materialId], { env, timeout: 30_000 });
    const restored = JSON.parse(read.stdout.trim());
    expect(restored.processId).not.toBe(created.processId);
    expect(restored.material).toMatchObject({ id: created.materialId, studySetId: created.setId,
      title: '持久化笔记', body: '保存到独立服务\n😀', version: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 65_000);
