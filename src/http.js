const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export class NetworkError extends Error {
  constructor(cause) {
    const code = cause?.cause?.code ?? cause?.code;
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    super(timedOut ? 'Request timed out' : `Network error${code ? ` (${code})` : ''}`);
    this.name = 'NetworkError';
    /** False only when the request provably never reached the server. */
    this.maybeDelivered = timedOut || !NOT_SENT_CODES.has(code);
  }
}

export function parseRetryAfterMs(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function requestJson(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 20_000 } = {}) {
  let response;
  let text;
  try {
    response = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    text = await response.text();
  } catch (err) {
    throw new NetworkError(err);
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json };
}

export function formBody(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}
