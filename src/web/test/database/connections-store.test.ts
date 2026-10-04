/**
 * Browser twin of the connection store's read side (plan B3): which stored
 * connections exist, so which connection_id smart import Apply accepts. Uses
 * the fixture the server test (tests/connectors/test_store.py) checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ClientDatabase } from '@/database/client-database';
import {
  connectionExists,
  connectionIds,
  instantOf,
  readConnections,
  sanitize,
  writeConnections,
} from '@/database/local-connections-store';
import { createTestDatabase, useSequentialUuids } from './helpers';

interface Case {
  name: string;
  value: string | null;
  ids: string[];
}

const CASES = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), '../../tests/fixtures/connections_exists_cases.json'),
      'utf8'
    )
  ) as { cases: Case[] }
).cases;

interface SanitizeCase {
  name: string;
  now: string;
  value: string | null;
  sanitized: unknown;
}

const SANITIZE_CASES = (
  JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), '../../tests/fixtures/connections_sanitize_cases.json'),
      'utf8'
    )
  ) as { cases: SanitizeCase[] }
).cases;

let db: ClientDatabase;
let restore: () => void;
beforeEach(async () => {
  restore = useSequentialUuids();
  db = await createTestDatabase();
});
afterEach(() => {
  db.close();
  restore();
});

const store = (value: string): void => {
  db.execute("INSERT INTO app_settings (key, value, encrypted) VALUES ('connections', ?, 0)", [
    value,
  ]);
};

describe('connectionIds', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s matches the server', (_name, c) => {
    if (c.value !== null) store(c.value);
    expect(connectionIds(db)).toEqual(c.ids);
  });
});

describe('connectionExists', () => {
  const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const entry = {
    provider: 'demo',
    label: 'Demo',
    created_at: '2026-10-01T09:00:00Z',
    status: 'ok',
  };

  it('is true only for a stored, canonical id', () => {
    expect(connectionExists(db, ID)).toBe(false);
    store(JSON.stringify({ version: 1, items: { [ID]: entry } }));
    expect(connectionExists(db, ID)).toBe(true);
    expect(connectionExists(db, ID.toUpperCase())).toBe(false);
    expect(connectionExists(db, 'connections')).toBe(false);
    expect(connectionExists(db, '11111111-2222-4333-8444-555555555555')).toBe(false);
  });

  it('reads and never writes', () => {
    connectionExists(db, ID);
    expect(db.query("SELECT 1 FROM app_settings WHERE key = 'connections'")).toHaveLength(0);
  });
});

describe('sanitize (plan B5): the shared cases', () => {
  it.each(SANITIZE_CASES.map((c) => [c.name, c] as const))('%s matches the server', (_name, c) => {
    if (c.value !== null) store(c.value);
    expect(readConnections(db, instantOf(c.now)!)).toEqual(c.sanitized);
  });

  it('keys order and stored order survive a write', () => {
    const c = SANITIZE_CASES.find((x) => x.name === 'eleven valid connections keep the first ten')!;
    const now = instantOf(c.now)!;
    const written = writeConnections(db, JSON.parse(c.value!), now);
    expect(written).toEqual(c.sanitized);
    expect(readConnections(db, now)).toEqual(c.sanitized);
    const text = db.query<{ value: string; encrypted: number }>(
      "SELECT value, encrypted FROM app_settings WHERE key = 'connections'"
    )[0]!;
    expect(text.encrypted).toBe(0);
    expect(text.value.startsWith('{"items":{')).toBe(true);
    expect(Object.keys((JSON.parse(text.value) as { items: object }).items)).toEqual(
      Object.keys((c.sanitized as { items: object }).items).sort()
    );
  });

  it('keeps own keys named like Object.prototype members', () => {
    const entry = {
      provider: 'demo',
      label: 'Demo',
      created_at: '2026-10-01T09:00:00Z',
      status: 'ok',
      accounts: {} as Record<string, unknown>,
    };
    const account = {
      name: 'n',
      institution: null,
      currency: 'USD',
      kind: 'checking',
      role: 'cash_flow',
      label: 'n',
      account_key: `acct:${'a'.repeat(64)}`,
    };
    const raw = `{"version":1,"items":{"0f0e0d0c-0b0a-4908-8706-050403020100":${JSON.stringify(
      entry
    ).replace(
      '"accounts":{}',
      `"accounts":{"__proto__":${JSON.stringify(account)},"constructor":${JSON.stringify(account)}}`
    )}}}`;
    store(raw);
    const doc = readConnections(db);
    const accounts = doc.items['0f0e0d0c-0b0a-4908-8706-050403020100']!.accounts;
    expect(Object.keys(accounts)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(accounts)).toBe(Object.prototype);
    writeConnections(db, doc);
    expect(
      Object.keys(readConnections(db).items['0f0e0d0c-0b0a-4908-8706-050403020100']!.accounts)
    ).toEqual(['__proto__', 'constructor']);
  });

  it('parses timestamps to the microsecond', () => {
    expect(instantOf('2026-10-04T12:00:00.000001Z')! - instantOf('2026-10-04T12:00:00Z')!).toBe(1);
    expect(instantOf('2026-10-04T14:00:00+02:00')).toBe(instantOf('2026-10-04T12:00:00Z'));
    expect(instantOf('0001-01-01T00:00:00Z')).toBe(-62135596800000000);
    expect(instantOf('2026-10-04T23:59:60Z')).toBeNull();
    expect(instantOf('2026-10-04T12:00:00')).toBeNull();
  });
});
