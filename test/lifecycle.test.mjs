import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Splash } from '../lifecycle.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const options = { model: 'test-model', command: new URL('./server.mjs', import.meta.url).pathname, idleMs: 80, startupMs: 3000 };
test('concurrent streams keep one process alive until completion, then restart after idle', async () => {
  const s = new Splash(options);
  try {
    const [a, b] = await Promise.all([s.request('/chat/completions', {}), s.request('/chat/completions', {})]);
    assert.equal(a.headers.get('x-pid'), b.headers.get('x-pid'));
    const pid = Number(a.headers.get('x-pid'));
    await delay(160);
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(await a.text(), 'firstlast');
    assert.equal(await b.text(), 'firstlast');
    await delay(300);
    assert.throws(() => process.kill(pid, 0));
    const c = await s.request('/chat/completions', {});
    assert.notEqual(c.headers.get('x-pid'), String(pid));
    await c.body.cancel();
  } finally { await s.close(); }
});

test('cancelling a response releases its process after idle', async () => {
  const s = new Splash(options);
  try {
    const r = await s.request('/chat/completions', {});
    const pid = Number(r.headers.get('x-pid'));
    await r.body.cancel();
    await delay(300);
    assert.throws(() => process.kill(pid, 0));
  } finally { await s.close(); }
});

test('a missing executable reports startup failure and can be closed', async () => {
  const s = new Splash({ ...options, command: '/nonexistent/splash' });
  await assert.rejects(s.request('/chat/completions', {}), /ENOENT|exited/);
  await s.close();
});

for (const executable of [process.execPath, 'bun']) {
  test(`owner SIGKILL reaps its server under ${executable}`, async () => {
    const owner = spawn(executable, [new URL('./owner.mjs', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      const [data] = await once(owner.stdout, 'data');
      const pid = Number(String(data).trim());
      assert.ok(pid > 0);
      owner.kill('SIGKILL');
      await once(owner, 'exit');
      await delay(400);
      assert.throws(() => process.kill(pid, 0));
    } finally { owner.kill('SIGKILL'); }
  });
}

test('external server survives plugin close and idle', async () => {
  const owner = new Splash(options);
  try {
    await owner.ensure();
    const attached = new Splash({ baseURL: owner.baseURL, idleMs: 1 });
    const response = await attached.request('/chat/completions');
    const pid = Number(response.headers.get('x-pid'));
    await response.text();
    await attached.close();
    await delay(100);
    assert.doesNotThrow(() => process.kill(pid, 0));
  } finally { await owner.close(); }
});
