/**
 * The seam between the browser connection store (plan B5) and the WebCrypto
 * seal (plan B6, utils/connector-seal.ts).
 *
 * LocalAPI never seals or unseals: it is synchronous, and WebCrypto is not.
 * It only stores and hands back sealed values, and refuses anything that is
 * not one, so a plaintext credential can never reach the browser database.
 * The client.ts composites hold a `CredentialVault`: they seal before
 * `createConnection` / `replaceConnectionSecret` and unseal what
 * `beginConnectionCall` returns, for one v2 request.
 *
 * Sealed value (design 7.2, E3): `wc1:<iv base64>:<ciphertext base64>`,
 * AES-GCM with the connection id as additional data, so a value moved to
 * another connection does not open. A server `fernet:` value is not sealed
 * here and means reconnect.
 */

export const SEALED_PREFIX = 'wc1:';
/** Far above a sealed 4096-character Access URL; anything longer is not one. */
export const MAX_SEALED_CHARS = 16_384;
/** AES-GCM's 96-bit IV, as standard base64: 16 characters, no padding. */
export const SEALED_IV_BYTES = 12;
/** The ciphertext carries at least the 16-byte GCM tag: 24 base64 characters. */
const MIN_CIPHER_CHARS = 24;
/**
 * Exactly what utils/connector-seal.ts writes: the prefix, a 16-character IV
 * and a ciphertext of whole, correctly padded groups, all in the standard
 * base64 alphabet (btoa's; no URL-safe characters).
 */
const SEALED =
  /^wc1:[A-Za-z0-9+/]{16}:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/;
const HEAD_CHARS = SEALED_PREFIX.length + 16 + 1;

/** A browser-sealed credential value (shape only; only the vault can open it). */
export function isSealedValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SEALED_CHARS &&
    value.length - HEAD_CHARS >= MIN_CIPHER_CHARS &&
    SEALED.test(value)
  );
}

export interface CredentialVault {
  /** Seal `plaintext` (a compact JSON of the credentials) for one connection id. */
  seal(connectionId: string, plaintext: string): Promise<string>;
  /** Open a sealed value; rejects when it is not this connection's, or cannot be read. */
  unseal(connectionId: string, sealed: string): Promise<string>;
  /** Forget anything kept for this connection (the WebCrypto vault holds one key for all, so it may keep nothing). */
  delete(connectionId: string): Promise<void>;
}
