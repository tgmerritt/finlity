/**
 * The browser seal for connection credentials (plan B6, design 7.2): AES-GCM
 * 256 with a non-extractable WebCrypto key kept in IndexedDB
 * `FinlityConnectorKeys`, a fresh 96-bit IV per seal, and the connection id
 * as additional data. Uses Node's WebCrypto and fake-indexeddb, a
 * spec-following in-memory IndexedDB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  SealUnavailable,
  SealUnreadable,
  getOrCreateKey,
  seal,
  unseal,
  webCryptoVault,
  KEY_DB_NAME,
} from '@/utils/connector-seal';
import { isSealedValue, MAX_SEALED_CHARS } from '@/utils/credential-vault';
import { installWebCrypto } from './webcrypto-support';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ID2 = '11111111-2222-4333-8444-555555555555';
const SECRET = JSON.stringify({
  provider: 'simplefin',
  access_url: 'https://user:Zq9PlantedPassword@bridge.simplefin.org/simplefin',
});

const freshIndexedDB = (): void => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
};

describe('connector seal', () => {
  let restoreCrypto: () => void;

  beforeEach(() => {
    restoreCrypto = installWebCrypto();
    freshIndexedDB();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreCrypto();
  });

  it('round-trips a credential and emits a value the store accepts', async () => {
    const sealed = await seal(ID, SECRET);
    expect(isSealedValue(sealed)).toBe(true);
    expect(sealed.startsWith('wc1:')).toBe(true);
    expect(sealed).not.toContain('Zq9PlantedPassword');
    expect(await unseal(ID, sealed)).toBe(SECRET);
  });

  it('seals the largest credential within the store limit', async () => {
    const big = JSON.stringify({ provider: 'simplefin', access_url: 'x'.repeat(4096) });
    const sealed = await seal(ID, big);
    expect(sealed.length).toBeLessThanOrEqual(MAX_SEALED_CHARS);
    expect(isSealedValue(sealed)).toBe(true);
  });

  it('uses a fresh 96-bit IV for every seal', async () => {
    const a = await seal(ID, SECRET);
    const b = await seal(ID, SECRET);
    expect(a).not.toBe(b);
    const iv = Buffer.from(a.split(':')[1]!, 'base64');
    expect(iv.length).toBe(12);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });

  it('creates the key once, non-extractable, in its own IndexedDB database', async () => {
    const generate = vi.spyOn(globalThis.crypto.subtle, 'generateKey');
    const first = await getOrCreateKey();
    const second = await getOrCreateKey();
    await seal(ID, SECRET);
    expect(first.extractable).toBe(false);
    expect(first.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(first.usages.slice().sort()).toEqual(['decrypt', 'encrypt']);
    expect(second.extractable).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(KEY_DB_NAME).toBe('FinlityConnectorKeys');
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).toEqual(['FinlityConnectorKeys']);
    await expect(crypto.subtle.exportKey('raw', first)).rejects.toThrow();
  });

  it('keeps one key when two seals race on a fresh browser', async () => {
    const [a, b] = await Promise.all([seal(ID, 'one'), seal(ID, 'two')]);
    expect(await unseal(ID, a)).toBe('one');
    expect(await unseal(ID, b)).toBe('two');
  });

  it('refuses a value moved to another connection', async () => {
    const sealed = await seal(ID, SECRET);
    await expect(unseal(ID2, sealed)).rejects.toBeInstanceOf(SealUnreadable);
  });

  it('refuses a server fernet value, plaintext and malformed values', async () => {
    await getOrCreateKey();
    for (const value of [
      'fernet:gAAAAABlZXhhbXBsZQ==',
      SECRET,
      'wc1:',
      'wc1:AAAA:',
      'wc1:AAAAAAAAAAAAAAAA:AAAA',
      'wc1:!!!!:AAAA',
      `wc1:${'A'.repeat(MAX_SEALED_CHARS)}:AAAA`,
    ]) {
      await expect(unseal(ID, value)).rejects.toBeInstanceOf(SealUnreadable);
    }
  });

  it('refuses a tampered ciphertext', async () => {
    const sealed = await seal(ID, SECRET);
    const [prefix, iv, ct] = sealed.split(':') as [string, string, string];
    const bytes = Buffer.from(ct, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    await expect(unseal(ID, `${prefix}:${iv}:${bytes.toString('base64')}`)).rejects.toBeInstanceOf(
      SealUnreadable
    );
  });

  it('fails cleanly when the key is gone (site data cleared, another browser)', async () => {
    const sealed = await seal(ID, SECRET);
    freshIndexedDB();
    const generate = vi.spyOn(globalThis.crypto.subtle, 'generateKey');
    await expect(unseal(ID, sealed)).rejects.toBeInstanceOf(SealUnreadable);
    // Unseal never mints a key: a new one could never open the old value.
    expect(generate).not.toHaveBeenCalled();
    expect((await indexedDB.databases()).length).toBe(0);
  });

  it('a missing IndexedDB is SealUnavailable, not unreadable (it may come back)', async () => {
    const sealed = await seal(ID, SECRET);
    const saved = globalThis.indexedDB;
    (globalThis as unknown as { indexedDB: undefined }).indexedDB = undefined;
    try {
      await expect(unseal(ID, sealed)).rejects.toBeInstanceOf(SealUnavailable);
      await expect(seal(ID, SECRET)).rejects.toBeInstanceOf(SealUnavailable);
    } finally {
      (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = saved;
    }
    expect(await unseal(ID, sealed)).toBe(SECRET);
  });

  it('a failing key store or missing WebCrypto is SealUnavailable', async () => {
    const sealed = await seal(ID, SECRET);
    const databases = vi
      .spyOn(globalThis.indexedDB, 'databases')
      .mockRejectedValueOnce(new Error('UnknownError'));
    await expect(unseal(ID, sealed)).rejects.toBeInstanceOf(SealUnavailable);
    databases.mockRestore();
    const target = globalThis.crypto as unknown as Record<string, unknown>;
    const subtle = target.subtle;
    target.subtle = undefined;
    try {
      await expect(unseal(ID, sealed)).rejects.toBeInstanceOf(SealUnavailable);
    } finally {
      target.subtle = subtle;
    }
    expect(await unseal(ID, sealed)).toBe(SECRET);
  });

  it('two module instances racing on one fresh IndexedDB end up with one key', async () => {
    vi.resetModules();
    const a = await import('@/utils/connector-seal');
    vi.resetModules();
    const b = await import('@/utils/connector-seal');
    expect(a.getOrCreateKey).not.toBe(b.getOrCreateKey);
    const [sealedA, sealedB] = await Promise.all([a.seal(ID, 'from a'), b.seal(ID, 'from b')]);
    expect(await b.unseal(ID, sealedA)).toBe('from a');
    expect(await a.unseal(ID, sealedB)).toBe('from b');
  });

  it('never puts the plaintext in an error or the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const sealed = await seal(ID, SECRET);
    const errors: unknown[] = [];
    await unseal(ID2, sealed).catch((e: unknown) => errors.push(e));
    await unseal(ID, SECRET).catch((e: unknown) => errors.push(e));
    expect(errors).toHaveLength(2);
    for (const e of errors) {
      expect(String((e as Error).message)).not.toContain('Zq9Planted');
      expect(JSON.stringify(e)).not.toContain('Zq9Planted');
    }
    for (const spy of spies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('Zq9Planted');
      spy.mockRestore();
    }
  });

  it('serves the CredentialVault seam', async () => {
    const sealed = await webCryptoVault.seal(ID, SECRET);
    expect(await webCryptoVault.unseal(ID, sealed)).toBe(SECRET);
    await webCryptoVault.delete(ID);
    // One key for every connection: deleting a connection keeps the others readable.
    expect(await webCryptoVault.unseal(ID, sealed)).toBe(SECRET);
  });
});
