/** Shared fixtures and builders for the smart import apply, undo and summary tests. */

import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ClientDatabase } from '@/database/client-database';
import type { LocalAPI } from '@/database/local-api';
import { createTestApi, useSequentialUuids } from './helpers';

export const TODAY = '2026-10-04';
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const HASH_C = 'c'.repeat(64);
export const D1 = '2026-09-01';
export const D2 = '2026-09-08';
export const D3 = '2026-09-15';

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Env {
  db: ClientDatabase;
  api: LocalAPI;
  restore: () => void;
}

export async function setup(): Promise<Env> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0));
  const restore = useSequentialUuids();
  const { db, api } = await createTestApi();
  db.execute('DELETE FROM budget_expense_categories');
  ['Groceries', 'Dining', 'Debt Payments', 'Other'].forEach((name, i) =>
    db.execute('INSERT INTO budget_expense_categories (id, name, sort_order) VALUES (?, ?, ?)', [
      `cat-${name}`,
      name,
      i,
    ])
  );
  return { db, api, restore };
}

export function teardown(env: Env): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
  env.restore();
  env.db.close();
}

const TABLES = [
  'bank_statement_imports',
  'smart_import_meta',
  'import_transactions',
  'merchant_rules',
  'smart_import_ledger',
  'recurring_candidates',
  'budget_expenses',
  'liabilities',
  'liability_balance_snapshots',
  'app_settings',
];

/** A content hash of every table apply or undo can touch. */
export function tableHashes(db: ClientDatabase): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of TABLES) {
    const rows = db
      .query<Row>(`SELECT * FROM ${table}`)
      .map((r) => JSON.stringify(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))))
      .sort();
    out[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return out;
}

export function count(
  db: ClientDatabase,
  table: string,
  where = '1=1',
  params: unknown[] = []
): number {
  return db.query(`SELECT 1 FROM ${table} WHERE ${where}`, params).length;
}

export function addLiability(
  db: ClientDatabase,
  id = 'L1',
  o: {
    name?: string;
    balance?: number;
    asOf?: string;
    type?: string;
    lender?: string | null;
    snapshot?: boolean;
    expenseId?: string | null;
  } = {}
): void {
  const asOf = o.asOf ?? '2026-09-01';
  const balance = o.balance ?? 500;
  db.execute(
    `INSERT INTO liabilities (id, name, liability_type, lender, current_balance, balance_as_of,
       is_amortizing, expense_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      o.name ?? 'Visa',
      o.type ?? 'credit_card',
      o.lender ?? 'Sample Bank',
      balance,
      asOf,
      o.expenseId ?? null,
    ]
  );
  if (o.snapshot !== false) {
    db.execute(
      `INSERT INTO liability_balance_snapshots (id, liability_id, snapshot_date, balance, source)
       VALUES (?, ?, ?, ?, 'manual')`,
      [crypto.randomUUID(), id, asOf, balance]
    );
  }
}

export function addExpense(
  db: ClientDatabase,
  id = 'E1',
  name = 'Netflix',
  amount = 15.49,
  frequency = 'monthly',
  category = 'cat-Dining',
  o: { active?: boolean; entityId?: string | null } = {}
): void {
  db.execute(
    `INSERT INTO budget_expenses (id, name, amount, frequency, category_id, is_active, entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, name, amount, frequency, category, o.active === false ? 0 : 1, o.entityId ?? null]
  );
}

export function txn(posted: string, amount: number, merchant = 'NETFLIX', o: Row = {}): Row {
  return {
    posted_date: posted,
    amount,
    description: merchant,
    merchant_key: merchant,
    kind: 'expense',
    category_id: 'cat-Dining',
    category_source: 'rule',
    dedupe_key: `acct:one|${merchant}|${posted}|${amount}`,
    excluded: false,
    ...o,
  };
}

export function statement(fileHash: string = HASH_A, txns: Row[] = [], o: Row = {}): Row {
  const { key, kind, origin, closing, liabilityId, period, ...extra } = o;
  return {
    file_hash: fileHash,
    file_name: 'statement.csv',
    origin: origin ?? 'file',
    format: 'csv',
    parser: 'csv',
    account: {
      kind: kind ?? 'checking',
      key: key ?? 'acct:one',
      label: 'Main',
      last4: '1234',
      institution: 'Sample Bank',
    },
    period: period ?? { start: null, end: null },
    closing_balance: closing ?? null,
    liability_id: liabilityId ?? null,
    ai_used: false,
    transactions: txns,
    ...extra,
  };
}

export function applyBody(
  statements: Row[],
  o: { rules?: Row[]; recurring?: Row[]; batch?: string; entityId?: string } = {}
): Row {
  const body: Row = {
    batch_id: o.batch ?? 'batch-1',
    statements,
    rules: o.rules ?? [],
    recurring: o.recurring ?? [],
  };
  if (o.entityId) body.entity_id = o.entityId;
  return body;
}

export function candidate(
  decision: string,
  merchant = 'NETFLIX',
  o: {
    fileHash?: string;
    name?: string;
    amount?: number;
    frequency?: string;
    category?: string;
    expenseId?: string;
  } = {}
): Row {
  const body: Row = {
    merchant_key: merchant,
    name: o.name ?? 'Netflix',
    amount: o.amount ?? 15.49,
    frequency: o.frequency ?? 'monthly',
    category_id: o.category ?? 'cat-Dining',
    occurrences: 3,
    file_hash: o.fileHash ?? HASH_A,
    decision,
  };
  if (o.expenseId) body.expense_id = o.expenseId;
  return body;
}

export function basic(fileHash: string = HASH_A, o: Row = {}): Row {
  return statement(
    fileHash,
    [
      txn(D1, -15.49, 'NETFLIX'),
      txn(D2, -42.1, 'GROCER', { category_id: 'cat-Groceries' }),
      txn(D3, 2000, 'PAYROLL', { kind: 'income', category_id: null, category_source: 'none' }),
      txn(D3, -9, 'SKIPPED', { excluded: true }),
    ],
    o
  );
}
