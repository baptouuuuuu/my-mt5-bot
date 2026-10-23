import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SecretStore interface: encrypt(obj) -> string, decrypt(string) -> obj.
 * Local implementation: AES-256-GCM. Key comes from SECRET_KEY, else from a
 * generated key file (SECRET_KEY_FILE, mode 0600). Replace with a KMS/Vault
 * implementation in production.
 */
export class LocalSecretStore {
  constructor({ secretKey, secretKeyFile }) {
    let raw = secretKey;
    if (!raw) {
      if (fs.existsSync(secretKeyFile)) raw = fs.readFileSync(secretKeyFile, 'utf8').trim();
      else {
        raw = randomBytes(32).toString('hex');
        fs.mkdirSync(path.dirname(secretKeyFile), { recursive: true });
        fs.writeFileSync(secretKeyFile, raw, { mode: 0o600 });
      }
    }
    this.key = createHash('sha256').update(raw).digest();
  }

  encrypt(obj) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }

  decrypt(str) {
    const [iv, tag, data] = str.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
  }
}
