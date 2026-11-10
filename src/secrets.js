import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function decodeKey(encoded, source) {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== 32) throw new Error(`${source} must contain 32 random bytes encoded as base64.`);
  return key;
}

/** Returns the credential encryption key, creating data/secret.key (mode 600) on first run. */
export function loadKey({ secretKey, dataDir }) {
  if (secretKey) return decodeKey(secretKey, 'LISTRELAY_SECRET_KEY');
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return decodeKey(fs.readFileSync(file, 'utf8'), file);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

export class Sealer {
  #key;

  constructor(key) {
    this.#key = key;
  }

  seal(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ciphertext].map((part) =>
      typeof part === 'string' ? part : part.toString('base64url'),
    ).join('.');
  }

  open(sealed) {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1') throw new Error('Unsupported credential format.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  }
}
