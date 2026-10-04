/**
 * An in-memory CredentialVault for tests (plan B5). It keeps the plaintext in
 * a Map and hands out `wc1:` values shaped like the WebCrypto vault's (B6),
 * bound to the connection id, so tests can drive the seal seam without
 * WebCrypto. Never shipped: it lives under test/.
 */

import type { CredentialVault } from '@/utils/credential-vault';

export class VaultUnreadable extends Error {
  constructor() {
    super('The sealed value cannot be read.');
    this.name = 'VaultUnreadable';
  }
}

export function createMemoryVault(): CredentialVault & { size(): number } {
  const values = new Map<string, { connectionId: string; plaintext: string }>();
  let counter = 0;
  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  return {
    seal(connectionId, plaintext) {
      counter += 1;
      // A 12-byte IV (16 base64 characters) and a ciphertext of at least 16 bytes.
      const iv = `iv-${counter}`.padEnd(12, '.').slice(0, 12);
      const sealed = `wc1:${b64(iv)}:${b64(`ct-${counter}-${connectionId}`)}`;
      values.set(sealed, { connectionId, plaintext });
      return Promise.resolve(sealed);
    },
    unseal(connectionId, sealed) {
      const entry = values.get(sealed);
      if (!entry || entry.connectionId !== connectionId)
        return Promise.reject(new VaultUnreadable());
      return Promise.resolve(entry.plaintext);
    },
    delete(connectionId) {
      for (const [sealed, entry] of values) {
        if (entry.connectionId === connectionId) values.delete(sealed);
      }
      return Promise.resolve();
    },
    size: () => values.size,
  };
}
