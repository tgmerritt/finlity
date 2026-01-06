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
      const data = (await response.json()) as {
        hmac_key: string | null;
        signing_required: boolean;
      };
      store.set('sessionHmacKey', data.hmac_key);
      store.set('sessionSigningRequired', data.signing_required || false);
      console.log(
        `Session initialized: signing ${data.signing_required ? 'required' : 'not required'}`
      );
    } else {
      // Server returned an error status - log it for debugging
      console.warn(`Session init failed with status ${response.status}`);
    }
  } catch (error) {
    // Differentiate between expected failures (no server) and unexpected failures
    if (
      error instanceof TypeError &&
      (error.message.includes('Failed to fetch') || error.message.includes('NetworkError'))
    ) {
      // Network unavailable - expected in local-only mode
      console.log('Session init skipped (server not available - local mode)');
    } else {
      // Unexpected error - log for debugging
      console.error('Session initialization failed:', error);
    }
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
 * Compute SHA-256 hash of a string for body hashing.
 * @param data - String to hash
 * @returns Hex-encoded hash
 */
async function hashBody(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate signature headers for mutating requests.
 * Includes body hash to prevent tampering with request payload.
 * @param method - HTTP method
 * @param endpoint - API endpoint path
 * @param body - Request body (will be hashed and included in signature)
 * @returns Headers object with signature
 */
export async function generateSignatureHeaders(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<Record<string, string>> {
  const hmacKey = store.get('sessionHmacKey');
  if (!hmacKey) {
    // Log warning if signing is required but key is missing
    if (store.get('sessionSigningRequired')) {
      console.warn(`HMAC signing required but key missing for ${method} ${endpoint}`);
    }
    return {};
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  // Include body hash in signature to prevent tampering
  const bodyHash = body ? await hashBody(JSON.stringify(body)) : '';
  // Strip query parameters from endpoint to match backend request.url.path
  const cleanEndpoint = endpoint.split('?')[0];
  const message = `${timestamp}:${nonce}:${method}:${cleanEndpoint}:${bodyHash}`;
  const signature = await computeHmac(hmacKey, message);

  return {
    'X-Request-Timestamp': timestamp.toString(),
    'X-Request-Nonce': nonce,
    'X-Request-Signature': signature,
    ...(bodyHash && { 'X-Request-Body-Hash': bodyHash }),
  };
}

/**
 * Check if session signing is required.
 * @returns True if requests need to be signed
 */
export function isSigningRequired(): boolean {
  return store.get('sessionSigningRequired');
}
