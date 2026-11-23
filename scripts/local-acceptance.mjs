#!/usr/bin/env node
/** Explicit loopback-only acceptance environment. Never uses production accounts or DB. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--planplan-config' || !args[1].startsWith('/'))) {
  console.error('Usage: npm run local:acceptance -- [--planplan-config /absolute/private/OpenRouter.env]'); process.exit(2);
}
const env = { ...process.env, NODE_ENV: 'development', STUDYC_LOCAL_ACCEPTANCE: '1', VITE_LOCAL_ACCEPTANCE: '1' };
delete env.VITE_AUTH_MODE;
const children = [];
let stopped = false;
function stop(code = 0) {
  if (stopped) return; stopped = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 12_000).unref();
  Promise.all(children.map(child => new Promise(done => child.exitCode !== null ? done() : child.once('exit', done)))).then(() => process.exit(code));
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => stop());
function launch(command, childArgs) {
  const child = spawn(command, childArgs, { cwd: root, env, stdio: 'inherit' });
  children.push(child);
  child.on('error', () => stop(1));
  child.on('exit', code => { if (!stopped) stop(code ?? 1); });
}
launch(process.execPath, [resolve(root, 'server/node_modules/tsx/dist/cli.mjs'), 'server/scripts/local-dev.ts', ...args]);
let healthy = false;
for (let i = 0; i < 100 && !stopped; i++) {
  try { const response = await fetch('http://127.0.0.1:18790/readyz', { signal: AbortSignal.timeout(500) }); const body = await response.json(); if (response.ok && body.release === 'local-acceptance') { healthy = true; break; } } catch { /* Wait for the local child only. */ }
  await new Promise(done => setTimeout(done, 300));
}
if (!healthy) stop(1);
else launch(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5180', '--strictPort']);
