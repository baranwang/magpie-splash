import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverModels } from '../discovery.mjs';
import Plugin from '../index.mjs';
import { ModelRunner } from '../models.mjs';

async function install(root, id) {
  const assembly = join(root, '.resolved', id.replaceAll('/', '-'));
  const source = join(root, '.sources', id.replaceAll('/', '-'));
  const files = {};
  for (const name of ['config.json', 'target/config.json', 'target/model.safetensors', 'draft/config.json', 'draft/model.safetensors']) {
    const path = join(source, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, name.endsWith('.json') ? '{"max_position_embeddings":8192}' : 'weights');
    await mkdir(join(assembly, name, '..'), { recursive: true });
    await symlink(path, join(assembly, name));
    files[name] = { path, bytes: (await stat(path)).size };
  }
  await writeFile(join(assembly, 'model.json'), JSON.stringify({ version: 1, model: id, target_format: 'mlx-affine', vision_format: 'none', files }));
  await mkdir(join(root, id, '..'), { recursive: true });
  await symlink(assembly, join(root, id));
  return source;
}

test('refresh discovers installations, removes broken models and ignores old packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'splash-discovery-'));
  try {
    const a = await install(root, 'owner/a');
    const plugin = await Plugin({}, { modelsDir: root });
    assert.deepEqual(Object.keys(await plugin.provider.models()), ['owner/a']);
    await install(root, 'owner/b');
    assert.deepEqual(Object.keys(await plugin.provider.models()), ['owner/a', 'owner/b']);
    await rm(join(a, 'target/model.safetensors'));
    assert.deepEqual((await discoverModels(root)).map(m => m.id), ['owner/b']);
    const models = await plugin.provider.models();
    assert.equal(models['owner/b'].limit.context, 8192);
    const loader = await plugin.auth.loader(async () => ({ type: 'api', key: 'local' }));
    const response = await loader.fetch('http://127.0.0.1:8000/v1/chat/completions', { method: 'POST', body: '{"model":"owner/missing"}' });
    assert.equal(response.status, 404);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('switch waits for previous response then terminates old process', async () => {
  const runner = new ModelRunner({ command: new URL('./server.mjs', import.meta.url).pathname, idleMs: 50 });
  const model = id => ({ id, args: [], limit: { context: 4096 } });
  try {
    const a = await runner.request(model('a'), '/chat/completions', {});
    const pid = Number(a.headers.get('x-pid'));
    let switched = false;
    const pending = runner.request(model('b'), '/chat/completions', {}).then(r => { switched = true; return r; });
    assert.equal(switched, false);
    assert.equal(await a.text(), 'firstlast');
    const b = await pending;
    assert.equal(b.headers.get('x-model'), 'b');
    assert.throws(() => process.kill(pid, 0));
    await b.body.cancel();
  } finally { await runner.runtime?.close(); }
});
