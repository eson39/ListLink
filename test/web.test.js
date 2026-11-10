import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createApp } from '../src/web.js';
import { setup } from './helpers.js';

let server;
let base;
let ctx;

before(async () => {
  ctx = setup();
  server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  base = `http://localhost:${port}`;
  const config = { port, baseUrl: base, pollIntervalMs: 60_000, appPassword: null };
  const gmail = Object.assign(ctx.gmail, { isConfigured: () => true });
  const slack = Object.assign(ctx.slack, { isOAuthConfigured: () => false });
  server.on('request', createApp({ config, store: ctx.store, relay: ctx.relay, gmail, slack }));
});

after(() => server.close());

async function csrf() {
  const html = await (await fetch(`${base}/`)).text();
  return /name="csrf" value="([^"]+)"/.exec(html)[1];
}

function post(path, fields, headers = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields),
  });
}

test('same-origin form posts can turn automation on and off', async () => {
  const token = await csrf();
  let res = await post('/toggle', { csrf: token, enabled: 'on' }, { Origin: base });
  assert.equal(res.status, 303);
  assert.equal(ctx.store.getSettings().enabled, true);

  res = await post('/toggle', { csrf: token, enabled: 'off' }, { Origin: base });
  assert.equal(res.status, 303);
  assert.equal(ctx.store.getSettings().enabled, false);
});

test('cross-origin posts and posts without a CSRF token change nothing', async () => {
  const token = await csrf();
  assert.equal((await post('/toggle', { csrf: token, enabled: 'on' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/toggle', { csrf: token, enabled: 'on' }, { Origin: 'null' })).status, 403);
  await post('/toggle', { enabled: 'on' }, { Origin: base });
  assert.equal(ctx.store.getSettings().enabled, false);
});

test('unexpected Host headers are rejected', async () => {
  const res = await new Promise((resolve) => {
    http.get(`${base}/`, { headers: { Host: 'attacker.example' } }, resolve);
  });
  assert.equal(res.statusCode, 421);
  res.resume();
});

test('the page shows the exact filter and the switch state', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /to:cs3157@lists\.cs\.columbia\.edu -subject:ANN/);
  assert.match(html, /OFF ○/);
  assert.match(html, /Paused — no automatic posts/);
});
