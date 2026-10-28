import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// The open stdin pipe is the owner's lease, including when it is killed with SIGKILL.
let child;
let stopping = false;
let escalation;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child?.pid) return process.exit(0);
  signal('SIGTERM');
  escalation = setTimeout(() => signal('SIGKILL'), 5000);
}
function signal(name) {
  try { process.kill(-child.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
const lines = createInterface({ input: process.stdin });
lines.once('line', line => {
  const { command, args, apiKey } = JSON.parse(line);
  child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, SPLASH_API_KEY: apiKey },
  });
  child.stderr.pipe(process.stderr);
  child.on('error', e => { console.error(e.message); process.exit(1); });
  child.on('exit', code => {
    clearTimeout(escalation);
    // Also clean up any descendants left by an unexpectedly exiting launcher.
    signal('SIGKILL');
    process.exit(stopping ? 0 : (code || 1));
  });
  if (stopping) { stopping = false; stop(); }
});
lines.on('close', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
