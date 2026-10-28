import { Splash } from './lifecycle.mjs';

export class ModelRunner {
  constructor(options) { this.options = options; this.queue = []; this.runtime = undefined; this.switching = false; }
  request(model, path, init) {
    return new Promise((resolve, reject) => {
      const item = { model, path, init, resolve, reject };
      if (init.signal?.aborted) return reject(init.signal.reason);
      item.abort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) { this.queue.splice(index, 1); reject(init.signal.reason); this.drain(); }
      };
      init.signal?.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item);
      void this.drain();
    });
  }
  async drain() {
    if (this.switching || !this.queue.length) return;
    const first = this.queue[0];
    if (this.runtime?.options.model !== first.model.id) {
      if (this.runtime?.active) return;
      this.switching = true;
      try {
        await this.runtime?.close();
        this.runtime = new Splash({ ...this.options, model: first.model.id,
          args: [...(this.options.args || []), ...first.model.args, '--max-context', String(first.model.limit.context)],
          onRelease: () => { void this.drain(); },
        });
      } finally { this.switching = false; }
    }
    while (this.queue.length && this.queue[0].model.id === this.runtime.options.model) {
      const item = this.queue.shift();
      item.init.signal?.removeEventListener('abort', item.abort);
      this.runtime.request(item.path, item.init).then(item.resolve, item.reject);
    }
    if (!this.runtime.active && this.queue.length) void this.drain();
  }
}
