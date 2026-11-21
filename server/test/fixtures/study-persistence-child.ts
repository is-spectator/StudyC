import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrations.js';
import { createApp } from '../../src/api/app.js';
import { sharedIdentity } from '../database.js';

const [mode, directory, inputUser, setId, materialId] = process.argv.slice(2);
if (!directory || !['write', 'read'].includes(mode ?? '')) throw new Error('Invalid isolated persistence fixture');
const db = await openDb(`pglite://${directory}`, { migrations: mode === 'write' ? 'none' : 'check' });
try {
  if (mode === 'write') { await sharedIdentity(db); await migrate(db); }
  const userId = inputUser ?? (await db.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id'))[0]!.id;
  const csrfToken = 'x'.repeat(43);
  const sessionFetch: typeof fetch = async () => Response.json({ userId, csrfToken });
  const app = createApp(db, { releaseId: 'persistence-test', rateLimitSecret: new TextEncoder().encode('disk-fixture-shared-rate-secret-32'), sessionFetch });
  const headers = { cookie: `__Host-planplan-session=${userId}`, origin: 'https://study.clyna.ai',
    'X-PlanPlan-Expected-User': userId, 'X-CSRF-Token': csrfToken, 'content-type': 'application/json' };
  if (mode === 'write') {
    const created = await app.request('/v1/study/sets', { method: 'POST', headers, body: JSON.stringify({ clientRequestId: randomUUID(), title: '跨进程学习集' }) });
    if (created.status !== 201) throw new Error('Fixture set creation failed');
    const { studySet } = await created.json();
    const saved = await app.request(`/v1/study/sets/${studySet.id}/materials`, { method: 'POST', headers,
      body: JSON.stringify({ clientRequestId: randomUUID(), title: '持久化笔记', body: '保存到独立服务\n😀' }) });
    if (saved.status !== 201) throw new Error('Fixture material creation failed');
    const { material } = await saved.json();
    console.log(JSON.stringify({ processId: process.pid, userId, setId: studySet.id, materialId: material.id }));
  } else {
    const response = await app.request(`/v1/study/sets/${setId}/materials/${materialId}`, { headers });
    if (response.status !== 200) throw new Error('Fixture material restore failed');
    console.log(JSON.stringify({ processId: process.pid, ...(await response.json()) }));
  }
} finally { await db.close(); }
