import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const commandHelp = new Map();
async function compatibleArgs(command, args) {
  if (!args.includes('--model-dir')) return args;
  if (!commandHelp.has(command)) {
    commandHelp.set(command, promisify(execFile)(command, ['serve', '--help'], { timeout: 10000 })
      .then(({ stdout }) => stdout.includes('--model-dir'))
      .catch(error => { commandHelp.delete(command); throw error; }));
  }
  if (await commandHelp.get(command)) return args;
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (['--model-dir', '--mmproj', '--draft-model'].includes(args[i])) { i++; continue; }
    result.push(args[i]);
  }
  return result;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export class Splash {
  constructor(options = {}) {
    this.options = options;
    this.baseURL = options.baseURL?.replace(/\/$/, '');
    this.external = Boolean(this.baseURL);
    this.apiKey = options.apiKey || (this.external ? 'local' : randomBytes(24).toString('hex'));
    this.active = 0;
    this.closed = false;
  }

  async ensure() {
    if (this.closed) throw new Error('Splash provider is closed');
    if (this.external) return;
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.start();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  async start() {
    if (this.stopping) await this.stopping;
    const command = this.options.command || 'splash';
    const serveArgs = await compatibleArgs(command, this.options.args || []);
    const port = await freePort();
    this.baseURL = `http://127.0.0.1:${port}/v1`;
    const child = spawn(process.execPath, [new URL('./supervisor.mjs', import.meta.url).pathname], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.child = child;
    let failure;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.stdin.on('error', () => {});
    const exited = new Promise(resolve => {
      child.once('error', error => { failure = error; resolve(); });
      child.once('exit', code => { failure ??= new Error(`Splash exited (${code}): ${stderr}`); resolve(); });
    });
    this.exited = exited;
    exited.then(() => { if (this.child === child) this.child = undefined; });
    const args = ['serve', ...serveArgs, '--model', this.options.model, '--host', '127.0.0.1', '--port', String(port), '--idle-release', 'off', '--no-webui'];
    child.stdin.write(JSON.stringify({ command, args, apiKey: this.apiKey }) + '\n');
    const deadline = Date.now() + (this.options.startupMs ?? 600000);
    try {
      while (Date.now() < deadline) {
        if (failure) throw failure;
        if (this.closed) throw new Error('Splash provider is closed');
        try {
          const res = await fetch(`${this.baseURL}/models`, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(1000) });
          if (res.ok) {
            const list = await res.json();
            if (list.data?.some(m => m.owned_by === 'splash' && m.id === this.options.model)) return;
          }
        } catch {}
        await Promise.race([delay(100), exited]);
      }
      throw new Error(`Splash startup timed out after ${this.options.startupMs ?? 600000} ms: ${stderr}`);
    } catch (error) { await this.stop(); throw error; }
  }

  async stop() {
    clearTimeout(this.timer);
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.end();
    this.stopping = this.exited;
    try { await this.stopping; } finally { this.stopping = undefined; }
  }

  release() {
    this.active--;
    if (!this.active && !this.external && !this.closed) {
      this.timer = setTimeout(() => { void this.stop(); }, this.options.idleMs ?? 300000);
      this.timer.unref?.();
    }
    this.options.onRelease?.();
  }

  async request(path, init = {}) {
    this.active++;
    clearTimeout(this.timer);
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', finish);
      this.release();
    };
    try {
      signal.throwIfAborted();
      await this.ensure();
      signal.throwIfAborted();
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.apiKey}`);
      const res = await fetch(this.baseURL + path, { ...init, headers, signal });
      if (!res.body) { finish(); return res; }
      const reader = res.body.getReader();
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
      const body = new ReadableStream({
        async pull(out) {
          try {
            const part = await reader.read();
            if (part.done) { finish(); out.close(); } else out.enqueue(part.value);
          } catch (error) { finish(); out.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { controller.abort(reason); finish(); } },
      });
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (error) { finish(); throw error; }
  }

  async close() {
    this.closed = true;
    if (this.starting) await this.starting.catch(() => {});
    await this.stop();
  }
}
