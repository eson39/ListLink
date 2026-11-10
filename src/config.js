import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3157);
  const host = env.HOST || '127.0.0.1';
  const tlsCertFile = env.TLS_CERT_FILE || null;
  const tlsKeyFile = env.TLS_KEY_FILE || null;
  const scheme = tlsCertFile && tlsKeyFile ? 'https' : 'http';
  const config = {
    port,
    host,
    baseUrl: (env.BASE_URL || `${scheme}://localhost:${port}`).replace(/\/+$/, ''),
    tlsCertFile,
    tlsKeyFile,
    dataDir: path.resolve(env.DATA_DIR || 'data'),
    secretKey: env.LISTRELAY_SECRET_KEY || null,
    appPassword: env.APP_PASSWORD || null,
    pollIntervalMs: Math.max(15, Number(env.POLL_INTERVAL_SECONDS || 60)) * 1000,
    google: { clientId: env.GOOGLE_CLIENT_ID || null, clientSecret: env.GOOGLE_CLIENT_SECRET || null },
    slack: { clientId: env.SLACK_CLIENT_ID || null, clientSecret: env.SLACK_CLIENT_SECRET || null },
  };
  if (!LOOPBACK_HOSTS.has(host) && !config.appPassword) {
    throw new Error(`HOST=${host} exposes ListRelay beyond this computer. Set APP_PASSWORD so only you can change settings.`);
  }
  return config;
}
