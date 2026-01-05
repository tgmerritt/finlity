/**
 * Session management for multi-user mode.
 * Handles HMAC request signing for secure API calls.
 */

import { store } from './store';

const API_BASE = '';

/**
 * Initialize session for multi-user mode.
 * Gets HMAC key for request signing if required by server.
 */
export async function initSession(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/session/init`, {
      credentials: 'include',
    });

    if (response.ok) {
      const data = (await response.json()) as { hmac_key: string | null; signing_required: boolean };
      store.set('sessionHmacKey', data.hmac_key);
      store.set('sessionSigningRequired', data.signing_required || false);
      console.log(
        `Session initialized: signing ${data.signing_required ? 'required' : 'not required'}`
      );
    }
  } catch (error) {
    // Session init is optional - local mode doesn't require it
    console.log('Session init skipped (local mode)');
  }
}

/**
 * Compute HMAC-SHA256 signature using Web Crypto API.
 * @param key - Secret key
 * @param message - Message to sign
 * @returns Hex-encoded signature
 */
export async function computeHmac(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate signature headers for mutating requests.
 * @param method - HTTP method
 * @param endpoint - API endpoint path
 * @returns Headers object with signature
 */
export async function generateSignatureHeaders(
  method: string,
  endpoint: string
): Promise<Record<string, string>> {
  const hmacKey = store.get('sessionHmacKey');
  if (!hmacKey) return {};

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const message = `${timestamp}:${nonce}:${method}:${endpoint}`;
  const signature = await computeHmac(hmacKey, message);

  return {
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
  };
}

/**
 * Check if session signing is required.
 * @returns True if requests need to be signed
 */
export function isSigningRequired(): boolean {
  return store.get('sessionSigningRequired');
}
