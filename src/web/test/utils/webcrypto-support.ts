/**
 * Put Node's real WebCrypto behind the global `crypto` that test/setup.ts
 * mocks (its `subtle` only stubs the HMAC calls). Returns a restore function
 * for afterEach. `randomUUID` is left alone: tests that mint ids set it.
 */

import { webcrypto } from 'node:crypto';

export function installWebCrypto(): () => void {
  const target = globalThis.crypto as unknown as Record<string, unknown>;
  const saved = { subtle: target.subtle, getRandomValues: target.getRandomValues };
  target.subtle = webcrypto.subtle;
  target.getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
  return () => {
    target.subtle = saved.subtle;
    target.getRandomValues = saved.getRandomValues;
  };
}
