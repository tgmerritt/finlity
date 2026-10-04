/**
 * Tests for the local/remote dispatcher (src/api/dispatcher.ts).
 *
 * Covers one representative endpoint per route category (LOCAL, PAYLOAD,
 * PASSTHROUGH, DISABLED) plus a buildPortfolioPayload shape test against a
 * seeded clientDB, per the WS3 plan's testing requirements.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import {
  tryLocalRoute,
  matchPayloadRoute,
  isPassthroughAllowed,
  NOT_HANDLED,
  LocalModeDisabledError,
  buildPortfolioPayload,
  resetLocalAPICache,
  type HttpMethod,
} from '@/api/dispatcher';

describe('dispatcher', () => {
  let restoreUuids: () => void;

  beforeEach(async () => {
    restoreUuids = useSequentialUuids();
    clientDB.close();
    await clientDB.createNew();
    resetLocalAPICache();
  });

  afterEach(() => {
    restoreUuids();
    clientDB.close();
  });

  describe('LOCAL routes', () => {
    it('serves GET /api/portfolio/accounts entirely from LocalAPI (no network)', async () => {
      const result = await tryLocalRoute('/api/portfolio/accounts', { method: 'GET' });
      expect(result).not.toBe(NOT_HANDLED);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    it('creates an account via POST /api/portfolio/accounts and it is retrievable', async () => {
      const created = await tryLocalRoute('/api/portfolio/accounts', {
        method: 'POST',
        body: { name: 'Fidelity Brokerage', account_type: 'taxable' },
      });
      expect(created).not.toBe(NOT_HANDLED);
      expect((created as { name: string }).name).toBe('Fidelity Brokerage');

      const accounts = await tryLocalRoute('/api/portfolio/accounts', { method: 'GET' });
      expect((accounts as Array<{ name: string }>).length).toBe(1);
    });

    it('parses path params for parameterized routes (DELETE /api/portfolio/accounts/{id})', async () => {
      const created = (await tryLocalRoute('/api/portfolio/accounts', {
        method: 'POST',
        body: { name: 'Chase Checking', account_type: 'checking' },
      })) as { id: string };

      const result = await tryLocalRoute(`/api/portfolio/accounts/${created.id}`, {
        method: 'DELETE',
      });
      expect(result).not.toBe(NOT_HANDLED);

      const accounts = await tryLocalRoute('/api/portfolio/accounts', { method: 'GET' });
      expect(accounts).toEqual([]);
    });

    it('does not match /api/analysis/triggers/evaluate as a LOCAL trigger CRUD route', async () => {
      // Trigger CRUD (GET/POST/DELETE /api/analysis/triggers) is LOCAL, but
      // evaluate/triggered must fall through to PAYLOAD instead.
      const result = await tryLocalRoute('/api/analysis/triggers/evaluate', { method: 'GET' });
      expect(result).toBe(NOT_HANDLED);
    });
  });

  describe('PAYLOAD routes', () => {
    it('rewrites GET /api/projections/account-balances-by-type (what the Taxes page sends) into the v2 POST', () => {
      const match = matchPayloadRoute('/api/projections/account-balances-by-type', {
        method: 'GET',
      });
      expect(match).not.toBe(NOT_HANDLED);
      if (match === NOT_HANDLED) throw new Error('unreachable');
      expect(match.endpoint).toBe('/api/v2/projections/account-balances-by-type');
      expect(match.options.method).toBe('POST');
      expect(match.options.body).toHaveProperty('accounts');
      expect(
        matchPayloadRoute('/api/projections/account-balances-by-type', { method: 'POST' })
      ).toBe(NOT_HANDLED);
    });

    it('rewrites GET /api/analysis/allocation into a POST /api/v2/analysis/allocation with a portfolio body', () => {
      const match = matchPayloadRoute('/api/analysis/allocation', { method: 'GET' });
      expect(match).not.toBe(NOT_HANDLED);
      if (match === NOT_HANDLED) throw new Error('unreachable');
      expect(match.endpoint).toBe('/api/v2/analysis/allocation');
      expect(match.options.method).toBe('POST');
      expect(match.options.body).toHaveProperty('accounts');
    });

    it('rewrites GET /api/analysis/triggers/triggered to POST /api/v2/triggers/evaluate with a postProcess filter', () => {
      const match = matchPayloadRoute('/api/analysis/triggers/triggered', { method: 'GET' });
      expect(match).not.toBe(NOT_HANDLED);
      if (match === NOT_HANDLED) throw new Error('unreachable');
      expect(match.endpoint).toBe('/api/v2/triggers/evaluate');
      expect(typeof match.postProcess).toBe('function');

      const filtered = match.postProcess!([
        { triggered: true, trigger_id: 'a' },
        { triggered: false, trigger_id: 'b' },
      ]);
      expect(filtered).toEqual([{ triggered: true, trigger_id: 'a' }]);
    });

    it('does not match a PASSTHROUGH-only endpoint like /api/session/init', () => {
      const match = matchPayloadRoute('/api/session/init', { method: 'GET' });
      expect(match).toBe(NOT_HANDLED);
    });
  });

  describe('PASSTHROUGH (unmatched by LOCAL or PAYLOAD tables)', () => {
    it('leaves /api/session/init, /api/tasks/*, and /api/v2/** unmatched by both tables', async () => {
      for (const endpoint of [
        '/api/session/init',
        '/api/tasks/abc123',
        '/api/v2/analysis/allocation',
        '/api/inference/providers',
        '/api/settings/deployment-info',
      ]) {
        const localResult = await tryLocalRoute(endpoint, { method: 'GET' });
        expect(localResult).toBe(NOT_HANDLED);
        const payloadResult = matchPayloadRoute(endpoint, { method: 'GET' });
        expect(payloadResult).toBe(NOT_HANDLED);
      }
    });

    it('is an explicit allowlist (F5): isPassthroughAllowed only allows session/tasks/v2/settings-version/deployment-info/inference-providers/health', () => {
      const allowed: Array<[string, HttpMethod]> = [
        ['/api/session/init', 'GET'],
        ['/api/tasks/abc123', 'GET'],
        ['/api/v2/analysis/allocation', 'POST'],
        ['/api/settings/version', 'GET'],
        ['/api/settings/deployment-info', 'GET'],
        ['/api/inference/providers', 'GET'],
        ['/health', 'GET'],
      ];
      for (const [endpoint, method] of allowed) {
        expect(isPassthroughAllowed(endpoint, method)).toBe(true);
      }

      const disallowed: Array<[string, HttpMethod]> = [
        ['/api/settings/version', 'POST'],
        ['/api/some/unmapped/endpoint', 'GET'],
        ['/api/analysis/some-new-v1-endpoint', 'GET'],
      ];
      for (const [endpoint, method] of disallowed) {
        expect(isPassthroughAllowed(endpoint, method)).toBe(false);
      }
    });
  });

  describe('DISABLED routes', () => {
    it('returns server-shaped stubs for the plugin list endpoints', () => {
      // features/plugins.ts calls plugins.forEach on /api/plugins (bare array)
      // and permData.plugins.forEach / pending_count on security/permissions.
      expect(tryLocalRoute('/api/plugins', { method: 'GET' })).toEqual([]);
      expect(tryLocalRoute('/api/plugins/installed', { method: 'GET' })).toEqual({
        plugins: [],
        count: 0,
      });
      expect(tryLocalRoute('/api/plugins/security/permissions', { method: 'GET' })).toEqual({
        plugins: [],
        pending_count: 0,
      });
    });

    it('throws LocalModeDisabledError for plugin endpoints', () => {
      expect(() =>
        tryLocalRoute('/api/plugins/install/git', { method: 'POST', body: {} })
      ).toThrow(LocalModeDisabledError);
    });

    it('returns a single synthetic profile for GET /api/profiles', () => {
      const result = tryLocalRoute('/api/profiles', { method: 'GET' });
      expect(result).not.toBe(NOT_HANDLED);
      const profiles = result as Array<{ id: string; is_active: boolean }>;
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.id).toBe('local');
      expect(profiles[0]!.is_active).toBe(true);
    });

    it('throws LocalModeDisabledError when creating a profile', () => {
      expect(() =>
        tryLocalRoute('/api/profiles', { method: 'POST', body: { name: 'x' } })
      ).toThrow(LocalModeDisabledError);
    });

    it('returns empty api_keys status without throwing', () => {
      const result = tryLocalRoute('/api/settings/api-keys/status', { method: 'GET' });
      expect(result).toEqual({ api_keys: {} });
    });

    it('throws LocalModeDisabledError for api-key mutation endpoints', () => {
      expect(() =>
        tryLocalRoute('/api/settings/api-key', {
          method: 'POST',
          body: { key: 'anthropic_api_key', value: 'sk-x' },
        })
      ).toThrow(LocalModeDisabledError);
    });
  });

  describe('buildPortfolioPayload', () => {
    it('builds a PortfolioPayload with accounts and nested positions matching the local DB', async () => {
      const account = (await tryLocalRoute('/api/portfolio/accounts', {
        method: 'POST',
        body: { name: 'Vanguard IRA', account_type: 'traditional_ira' },
      })) as { id: string };

      await tryLocalRoute('/api/portfolio/positions', {
        method: 'POST',
        body: {
          account_id: account.id,
          ticker: 'VTI',
          shares: 10,
          current_price: 250,
          cost_basis: 2000,
        },
      });

      const payload = buildPortfolioPayload();
      expect(payload.accounts).toHaveLength(1);
      const acc = payload.accounts[0]!;
      expect(acc.name).toBe('Vanguard IRA');
      expect(acc.account_type).toBe('traditional_ira');
      expect(acc.positions).toHaveLength(1);
      const pos = acc.positions[0]!;
      expect(pos.ticker).toBe('VTI');
      expect(pos.shares).toBe(10);
      expect(pos.current_price).toBe(250);
      expect(pos.cost_basis).toBe(2000);
    });

    it('returns an empty accounts array for a fresh database', () => {
      const payload = buildPortfolioPayload();
      expect(payload).toEqual({ accounts: [] });
    });
  });
});
