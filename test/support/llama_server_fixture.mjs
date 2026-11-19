#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const port = Number(value('--port'));
const alias = value('--alias');
const mode = process.env.LLAMA_FIXTURE_MODE ?? 'ready';
const record = (event) => {
  if (process.env.LLAMA_FIXTURE_EVENTS) {
    fs.appendFileSync(process.env.LLAMA_FIXTURE_EVENTS,
      JSON.stringify({ event, pid: process.pid, alias, model: value('-m') }) + '\n');
  }
};
record('started');
if (mode === 'exit') process.exit(17);

const server = mode === 'idle' ? null : http.createServer((req, res) => {
  if (mode === 'hang') return;
  if (mode === 'exit-probe') process.exit(19);
  if (mode === 'html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not a model server</html>');
    return;
  }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') {
    res.end(JSON.stringify({ status: mode === 'loading' ? 'loading model' : 'ok' }));
  } else if (req.url === '/v1/models') {
    res.end(JSON.stringify({ object: 'list', data: mode === 'empty' ? [] : [
      { id: mode === 'wrong-model' ? 'unrelated-model' : alias, object: 'model' },
    ] }));
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});
server?.listen(port, '127.0.0.1', () => console.log('fixture listening'));
server?.on('error', () => process.exit(23));
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  record('stopping');
  console.log('old process stopping');
  if (process.env.LLAMA_FIXTURE_IGNORE_TERM === '1') return;
  setTimeout(() => {
    record('exited');
    clearInterval(timer);
    process.exit(0);
  }, Number(process.env.LLAMA_FIXTURE_STOP_DELAY ?? 0));
});
