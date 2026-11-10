import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { loadConfig } from './config.js';
import { GmailClient } from './gmail.js';
import { Relay } from './relay.js';
import { loadKey, Sealer } from './secrets.js';
import { SlackClient } from './slack.js';
import { Store } from './store.js';
import { createApp } from './web.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const store = new Store(path.join(config.dataDir, 'listrelay.db'), new Sealer(loadKey(config)));
const gmail = new GmailClient({
  ...config.google,
  redirectUri: `${config.baseUrl}/oauth/google/callback`,
  store,
});
const slack = new SlackClient({
  ...config.slack,
  redirectUri: `${config.baseUrl}/oauth/slack/callback`,
  store,
});
const relay = new Relay({ store, gmail, slack, pollIntervalMs: config.pollIntervalMs });
relay.recover();

const handler = createApp({ config, store, relay, gmail, slack });
const server =
  config.tlsCertFile && config.tlsKeyFile
    ? https.createServer({ cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile) }, handler)
    : http.createServer(handler);

server.listen(config.port, config.host, () => {
  const settings = store.getSettings();
  console.log(`ListRelay is running at ${config.baseUrl}`);
  console.log(`Automation is ${settings.enabled ? 'ON' : 'OFF'}.`);
  relay.start();
});

function shutdown() {
  relay.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
