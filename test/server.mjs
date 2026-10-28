#!/usr/bin/env node
import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const model = process.argv[process.argv.indexOf('--model') + 1];
http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: model, owned_by: 'splash', context_length: 4096, input_modalities: ['text'] }] }));
  } else {
    res.writeHead(200, { 'x-pid': String(process.pid), 'x-model': model });
    res.write('first');
    const timer = setTimeout(() => res.end('last'), 220);
    res.on('close', () => clearTimeout(timer));
  }
}).listen(port, '127.0.0.1');
