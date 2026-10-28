import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname } from 'node:path';

export const defaultModelsDir = join(homedir(), 'Library/Application Support/Splash/models');

export async function discoverModels(directory = defaultModelsDir) {
  const root = resolve(directory.replace(/^~(?=\/|$)/, homedir()));
  let groups;
  try { groups = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = new Map();
  for (const group of groups.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!group.isDirectory() || (group.name.startsWith('.') && group.name !== '.selections')) continue;
    for (const link of await readdir(join(root, group.name), { withFileTypes: true })) {
      if (!link.isSymbolicLink()) continue;
      const assembly = join(root, group.name, link.name);
      try {
        const record = JSON.parse(await readFile(join(assembly, 'model.json'), 'utf8'));
        if (record.version !== 1 || typeof record.model !== 'string' || !record.model || !['mlx-affine', 'gguf'].includes(record.target_format)) continue;
        const files = Object.entries(record.files ?? {});
        if (!files.some(([name]) => /^target\/.*\.(safetensors|gguf)$/.test(name)) || !files.some(([name]) => /^draft\/.*\.safetensors$/.test(name))) continue;
        for (const [name, entry] of files) {
          if (isAbsolute(name) || name.split('/').includes('..')) throw new Error('Invalid assembly path');
          const path = join(assembly, name);
          const info = await stat(path);
          if (!info.isFile() || info.size !== entry.bytes || await realpath(path) !== await realpath(entry.path)) throw new Error('Missing or changed model file');
        }
        const config = JSON.parse(await readFile(join(assembly, 'config.json'), 'utf8'));
        const target = record.target_format === 'gguf'
          ? files.find(([name]) => /^target\/.*\.gguf$/.test(name))[1].path
          : dirname(record.files['target/config.json'].path);
        const draft = dirname(record.files['draft/config.json'].path);
        const args = ['--model-dir', target, '--draft-model', draft, '--offline'];
        if (record.vision_format === 'gguf') args.push('--mmproj', record.files['vision/mmproj.gguf'].path);
        if (record.vision_format === 'none') args.push('--language-only');
        const context = config.text_config?.max_position_embeddings ?? config.max_position_embeddings;
        if (!found.has(record.model)) found.set(record.model, { id: record.model, args, vision: record.vision_format !== 'none', context });
      } catch (error) {
        console.error(`Splash: skipping ${assembly}: ${error.message}`);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
