/**
 * Session management for multi-user mode.
 * Handles HMAC request signing for secure API calls.
 */

import { store } from './store';
import type { DataMode } from './store';
import { showToast } from '@/ui/toast';

const API_BASE = '';

/**
 * localStorage override key for dev testing — lets a developer force
 * dataMode without standing up a multi_user_mode server. Real deployments
 * never need this; `multi_user_mode` from the server is authoritative.
 */
const DATA_MODE_OVERRIDE_KEY = 'dataMode';

/**
 * F3: localStorage key caching the last successfully-confirmed
 * `multi_user_mode` value from /api/session/init. Read only when a later
 * init call fails (network error or non-OK status), so a transient outage
 * on a hosted (multi_user_mode=true) deployment keeps routing to 'local'
 * instead of silently falling back to 'server' and leaking user data to v1
 * server-side endpoints.
 */
const LAST_KNOWN_MULTI_USER_MODE_KEY = 'lastKnownMultiUserMode';

/**
 * Resolve the effective dataMode for this session.
 *
 * `multi_user_mode` (from /api/session/init) is mandatory when true — hosted
 * deployments must not store user data server-side, so 'local' always wins
 * over any override in that direction. When the server reports
 * multi_user_mode=false (self-hosted Docker / single-user), a dev can still
 * force 'local' via localStorage for testing, but cannot force 'server' on
 * a multi-user deployment (that would violate the "no server storage in
 * hosted mode" requirement).
 */
function resolveDataMode(multiUserMode: boolean): DataMode {
  if (multiUserMode) return 'local';

  const override = localStorage.getItem(DATA_MODE_OVERRIDE_KEY);
  if (override === 'local') return 'local';
  return 'server';
}

/**
 * F3 fail-safe: resolve dataMode when /api/session/init could not be
 * reached or returned an error status. Never falls back to 'server' just
 * because the network call failed — that would silently route user data to
 * server-side v1 endpoints on what might actually be a hosted deployment
 * experiencing a transient outage. Order of preference:
 * 1. The last successfully-confirmed multi_user_mode value (localStorage).
 * 2. If there is no cached value at all (e.g. very first load, before any
 *    successful init), default to 'local' - the safe direction, since it
 *    never leaks data server-side even if this turns out to be a
 *    single-user self-hosted deployment (worst case there, the user sees
 *    local/browser storage instead of server storage, which is merely
 *    inconvenient, not a data-exposure risk).
 * Shows a warning toast either way so the user knows the mode was inferred
 * rather than confirmed.
 */
function resolveDataModeOnInitFailure(): DataMode {
  const cached = localStorage.getItem(LAST_KNOWN_MULTI_USER_MODE_KEY);
  const dataMode: DataMode = cached === null ? 'local' : resolveDataMode(cached === 'true');
  showToast('Could not confirm server mode — using local data mode', 'warning');
  return dataMode;
}

/**
 * Initialize session for multi-user mode.
 * Gets HMAC key for request signing if required by server, and resolves
 * `dataMode` (server vs local/hosted) from the `multi_user_mode` flag.
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
        multi_user_mode?: boolean;
      };
      const multiUserMode = data.multi_user_mode ?? false;
      store.set('sessionHmacKey', data.hmac_key);
      store.set('sessionSigningRequired', data.signing_required || false);
      store.set('multiUserMode', multiUserMode);
      store.set('dataMode', resolveDataMode(multiUserMode));
      // F3: remember this confirmed value so a later transient init
      // failure can fail safe instead of defaulting to 'server'.
      localStorage.setItem(LAST_KNOWN_MULTI_USER_MODE_KEY, String(multiUserMode));
      console.log(
        `Session initialized: signing ${data.signing_required ? 'required' : 'not required'}, ` +
          `dataMode=${store.get('dataMode')}`
      );
    } else {
      // Server returned an error status - log it for debugging
      console.warn(`Session init failed with status ${response.status}`);
      store.set('dataMode', resolveDataModeOnInitFailure());
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
    store.set('dataMode', resolveDataModeOnInitFailure());
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
