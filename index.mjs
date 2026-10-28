import { Splash } from './lifecycle.mjs';
import { discoverModels } from './discovery.mjs';
import { ModelRunner } from './models.mjs';

export default async function SplashPlugin(_input, options = {}) {
  const context = options.context ?? 262144;
  if (!Number.isInteger(context) || context < 1024) throw new Error('Splash context must be an integer >= 1024');
  for (const key of ['idleMs', 'startupMs']) {
    if (options[key] !== undefined && (!Number.isFinite(options[key]) || options[key] <= 0)) throw new Error(`Splash ${key} must be positive`);
  }
  const base = options.baseURL || 'http://127.0.0.1:8000/v1';
  const runner = new ModelRunner(options);
  let catalog = new Map();
  async function refresh() {
    const installed = options.baseURL
      ? (options.model ? [{ id: options.model, context, vision: options.vision }] : [])
      : await discoverModels(options.modelsDir);
    catalog = new Map(installed.map(model => {
      const window = Number.isInteger(model.context) ? Math.min(context, model.context) : context;
      return [model.id, { ...model,
        name: model.id, reasoning: true, tool_call: true,
        modalities: { input: model.vision ? ['text', 'image'] : ['text'], output: ['text'] },
        limit: { context: window, output: Math.min(32768, Math.floor(window / 4)) },
        variants: Object.fromEntries(['none', 'low', 'medium', 'high', 'xhigh'].map(effort => [effort, { reasoningEffort: effort }])),
      }];
    }));
    return Object.fromEntries([...catalog].map(([id, { args, context, vision, ...model }]) => [id, model]));
  }
  await refresh();
  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider.splash ??= { name: 'Splash', npm: '@ai-sdk/openai-compatible', api: base, models: await refresh() };
    },
    provider: {
      id: 'splash',
      async models() {
        const models = await refresh();
        return Object.fromEntries(Object.entries(models).map(([id, model]) => [id, {
          ...model, api: { id, url: base, npm: '@ai-sdk/openai-compatible' },
          capabilities: { reasoning: true, toolcall: true, attachment: model.modalities.input.includes('image'), input: { text: true, image: model.modalities.input.includes('image') }, output: { text: true } },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        }]));
      },
    },
    auth: {
      provider: 'splash',
      icon: 'https://avatars.githubusercontent.com/u/282140180',
      methods: options.baseURL
        ? [{ type: 'api', label: 'Splash API key' }]
        : [{ type: 'api', label: '启用本地 Splash', keyless: true,
            async authorize() { return { type: 'success', key: 'local', metadata: { email: 'Splash' } }; },
          }],
      async loader(getAuth) {
        const auth = await getAuth();
        const external = options.baseURL ? new Splash({ ...options, apiKey: auth?.type === 'api' ? auth.key : options.apiKey }) : undefined;
        return {
          baseURL: base,
          async fetch(input, init = {}) {
            const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
            const root = new URL(base);
            if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname.replace(/\/$/, '') + '/')) throw new Error('Unexpected Splash request URL');
            const path = url.pathname.slice(root.pathname.replace(/\/$/, '').length) + url.search;
            if (path === '/models' && (!init.method || init.method === 'GET')) {
              await refresh();
              return Response.json({ object: 'list', data: [...catalog.keys()].map(id => ({ id, object: 'model', owned_by: 'splash' })) });
            }
            if (external) return external.request(path, init);
            const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
            await refresh();
            const model = catalog.get(body.model);
            if (!model) return Response.json({ error: { message: `Splash model is not installed: ${body.model}`, type: 'invalid_request_error' } }, { status: 404 });
            return runner.request(model, path, init);
          },
        };
      },
    },
  };
}
