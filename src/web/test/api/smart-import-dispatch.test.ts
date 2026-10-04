/**
 * Hosted (local-mode) dispatch for smart import. Every data route resolves to
 * a LocalAPI handler, static routes win over {id}, the three AI routes are
 * rewritten to /api/v2/smart-import/* with the body unchanged and no local
 * data added, and nothing under /api/smart-import may reach the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useSequentialUuids } from '../database/helpers';
import { clientDB } from '@/database/client-database';
import {
  tryLocalRoute,
  matchPayloadRoute,
  isPassthroughAllowed,
  NOT_HANDLED,
  resetLocalAPICache,
  type HttpMethod,
} from '@/api/dispatcher';

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

const LOCAL_ROUTES: [HttpMethod, string, unknown][] = [
  ['GET', '/api/smart-import/context', undefined],
  ['POST', '/api/smart-import/preview', { statements: [] }],
  ['GET', '/api/smart-import/imports', undefined],
  ['GET', '/api/smart-import/rules', undefined],
  ['GET', '/api/smart-import/settings', undefined],
  ['PUT', '/api/smart-import/settings', {}],
  ['POST', '/api/smart-import/apply', { batch_id: 'b', statements: [] }],
  ['DELETE', '/api/smart-import/transactions', undefined],
  ['GET', '/api/budget/spending-summary', undefined],
];

const AI_ROUTES: [HttpMethod, string, string][] = [
  ['POST', '/api/smart-import/categorize', '/api/v2/smart-import/categorize'],
  ['POST', '/api/smart-import/extract', '/api/v2/smart-import/extract'],
  ['GET', '/api/smart-import/ai-status', '/api/v2/smart-import/status'],
];

describe('smart import local routes', () => {
  it.each(LOCAL_ROUTES)('%s %s is served from the browser database', (method, path, body) => {
    const result = tryLocalRoute(path, { method, body });
    expect(result).not.toBe(NOT_HANDLED);
    expect(matchPayloadRoute(path, { method, body })).toBe(NOT_HANDLED);
  });

  it('returns real data through the dispatcher', () => {
    const ctx = tryLocalRoute('/api/smart-import/context', { method: 'GET' }) as {
      settings: { retention_months: number };
    };
    expect(ctx.settings.retention_months).toBe(24);
    const put = tryLocalRoute('/api/smart-import/settings', {
      method: 'PUT',
      body: { retention_months: 12 },
    }) as { retention_months: number };
    expect(put.retention_months).toBe(12);
    expect(tryLocalRoute('/api/smart-import/settings', { method: 'GET' })).toMatchObject({
      retention_months: 12,
    });
  });

  it('resolves DELETE /rules/{id} to the rule handler and a static path never matches {id}', () => {
    clientDB.execute(
      "INSERT INTO merchant_rules (id, merchant_key, kind, source) VALUES ('r1', 'NETFLIX', 'expense', 'user')"
    );
    expect(tryLocalRoute('/api/smart-import/rules/r1', { method: 'DELETE' })).toEqual({
      deleted: true,
    });
    expect(() => tryLocalRoute('/api/smart-import/rules/r1', { method: 'DELETE' })).toThrow(
      /Rule not found/
    );
    // GET /rules is the list, not a rule named "rules"
    expect(tryLocalRoute('/api/smart-import/rules', { method: 'GET' })).toEqual([]);
  });

  it('applies, undoes and summarizes through the dispatcher', () => {
    const body = {
      batch_id: 'b',
      statements: [
        {
          file_hash: 'a'.repeat(64),
          file_name: 'x.csv',
          origin: 'file',
          format: 'csv',
          parser: 'csv',
          account: { kind: 'checking', key: 'acct:one' },
          transactions: [
            {
              posted_date: '2026-09-02',
              amount: -5,
              description: 'X',
              merchant_key: 'X',
              kind: 'expense',
              category_source: 'none',
              dedupe_key: 'k',
            },
          ],
        },
      ],
    };
    const out = tryLocalRoute('/api/smart-import/apply', { method: 'POST', body }) as {
      imports: { import_id: string; txn_new: number }[];
    };
    expect(out.imports[0]!.txn_new).toBe(1);
    const summary = tryLocalRoute('/api/budget/spending-summary?months=1&entity_id=', {
      method: 'GET',
    }) as { months: string[] };
    expect(summary.months.length).toBeLessThanOrEqual(1);
    expect(() =>
      tryLocalRoute('/api/budget/spending-summary?months=0', { method: 'GET' })
    ).toThrow();
    const undone = tryLocalRoute(`/api/smart-import/imports/${out.imports[0]!.import_id}`, {
      method: 'DELETE',
    }) as { undone: boolean };
    expect(undone.undone).toBe(true);
    expect(tryLocalRoute('/api/smart-import/transactions', { method: 'DELETE' })).toEqual({
      deleted: 0,
    });
  });

  it('does not match a method the route does not serve', () => {
    expect(tryLocalRoute('/api/smart-import/context', { method: 'POST' })).toBe(NOT_HANDLED);
    expect(tryLocalRoute('/api/smart-import/rules', { method: 'DELETE' })).toBe(NOT_HANDLED);
  });

  it('surfaces validation failures as LocalHttpError with the fixed 422 body', () => {
    try {
      tryLocalRoute('/api/smart-import/settings', {
        method: 'PUT',
        body: { retention_months: 13 },
      });
      throw new Error('expected a 422');
    } catch (e) {
      expect((e as { status: number }).status).toBe(422);
      expect((e as Error).message).toBe('The request could not be read.');
    }
  });
});

describe('smart import AI payload routes', () => {
  it.each(AI_ROUTES)('%s %s is rewritten to %s', (method, path, v2) => {
    expect(tryLocalRoute(path, { method })).toBe(NOT_HANDLED);
    const rewrite = matchPayloadRoute(path, { method });
    expect(rewrite).not.toBe(NOT_HANDLED);
    expect((rewrite as { endpoint: string }).endpoint).toBe(v2);
    expect((rewrite as { options: { method: string } }).options.method).toBe(method);
  });

  it.each([
    [
      '/api/smart-import/categorize',
      { merchants: [{ key: 'netflix', median: 16, count: 3 }], categories: ['Dining'] },
    ],
    ['/api/smart-import/extract', { file_hash: 'a'.repeat(64), lines: ['x'], line_count: 1 }],
  ])('%s forwards the body unchanged and adds no local data', (path, body) => {
    clientDB.execute(
      "INSERT INTO app_settings (key, value, encrypted) VALUES ('smart_import', '{\"ai_enabled\":true}', 0)"
    );
    const rewrite = matchPayloadRoute(path, { method: 'POST', body }) as {
      options: { body: unknown };
    };
    expect(rewrite.options.body).toBe(body);
    expect(JSON.stringify(rewrite.options.body)).toBe(JSON.stringify(body));
  });

  it('ai-status sends no body', () => {
    const rewrite = matchPayloadRoute('/api/smart-import/ai-status', { method: 'GET' }) as {
      options: { body?: unknown };
    };
    expect(rewrite.options.body).toBeUndefined();
  });
});

describe('hosted dispatch never sends smart import over the network', () => {
  const ALL: [HttpMethod, string][] = [
    ...LOCAL_ROUTES.map(([m, p]): [HttpMethod, string] => [m, p]),
    ['DELETE', '/api/smart-import/rules/r1'],
    ['DELETE', '/api/smart-import/imports/i1'],
    ...AI_ROUTES.map(([m, p]): [HttpMethod, string] => [m, p]),
  ];

  it.each(ALL)('%s %s is handled locally or rewritten, never passed through', (method, path) => {
    const body = path.endsWith('/apply')
      ? { batch_id: 'b', statements: [] }
      : method === 'POST'
        ? { statements: [] }
        : undefined;
    let handled = false;
    try {
      handled = tryLocalRoute(path, { method, body }) !== NOT_HANDLED;
    } catch {
      handled = true; // a local handler ran and failed (for example 404 rule): still local
    }
    const rewritten = matchPayloadRoute(path, { method, body });
    const isAi = AI_ROUTES.some(([, p]) => p === path);
    if (isAi) {
      expect(handled).toBe(false);
      expect((rewritten as { endpoint: string }).endpoint.startsWith('/api/v2/smart-import/')).toBe(
        true
      );
    } else {
      expect(handled).toBe(true);
      expect(rewritten).toBe(NOT_HANDLED);
    }
    // the unchanged v1 path must not be on the network allowlist either way
    expect(isPassthroughAllowed(path, method)).toBe(false);
  });

  it.each([
    ['GET', '/api/smart-import/anything-else'],
    ['PUT', '/api/smart-import/rules'],
    ['POST', '/api/smart-import/imports/i1'],
  ] as [HttpMethod, string][])(
    '%s %s (no such route) is not on the passthrough allowlist',
    (method, path) => {
      expect(isPassthroughAllowed(path, method)).toBe(false);
    }
  );

  it('allows the rewritten v2 paths, which is the only smart import traffic that may leave', () => {
    for (const [method, , v2] of AI_ROUTES) expect(isPassthroughAllowed(v2, method)).toBe(true);
  });
});
