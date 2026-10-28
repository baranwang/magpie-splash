import { Splash } from '../lifecycle.mjs';
const s = new Splash({ model: 'test-model', command: new URL('./server.mjs', import.meta.url).pathname });
const r = await s.request('/chat/completions');
console.log(r.headers.get('x-pid'));
setInterval(() => {}, 1000);
