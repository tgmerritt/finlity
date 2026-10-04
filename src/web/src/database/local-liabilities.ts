/**
 * Browser-SQLite liabilities (mirror of src/liabilities/service.py and
 * src/api/liabilities.py). Same validation, status codes and messages, same
 * computed fields, same expense-sync and property rules.
 *
 * Conventions: calendar dates are local-calendar 'YYYY-MM-DD' strings (never
 * built with toISOString); every UPDATE sets updated_at explicitly; nothing
 * here logs balances, payments, names or lenders (failures log the operation,
 * the id and the error type only).
 */

import type { ClientDatabase } from './client-database';
import { LocalHttpError } from './local-error';
import { today as clockToday } from '@/utils/clock';
import {
  PERIODS_PER_YEAR,
  balanceAt,
  daysInMonth,
  dueDatesBetween,
  monthEnds,
  pad,
  schedule,
  shift,
  summarize,
  type AmortizationSummary,
  type BalanceSnapshot,
} from '@/utils/amortization';
import type {
  ConvertPositionInput,
  ConvertPositionResult,
  CreateLiabilityInput,
  DashboardLiabilities,
  DeleteLiabilityResult,
  LiabilityHistoryResponse,
  LiabilityResponse,
  RecordBalanceInput,
  RevertConversionResult,
  UpdateLiabilityInput,
} from '@/types/api';

const TYPES = [
  'mortgage',
  'auto_loan',
  'student_loan',
  'credit_card',
  'personal_loan',
  'heloc',
  'other',
];
const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'];
const AMORTIZING_BY_TYPE: Record<string, boolean> = {
  mortgage: true,
  auto_loan: true,
  student_loan: true,
  credit_card: false,
  personal_loan: true,
  heloc: false,
  other: false,
};
const CATEGORY_BY_TYPE: Record<string, string> = {
  mortgage: 'Housing',
  heloc: 'Housing',
  auto_loan: 'Transportation',
};
const DEFAULT_CATEGORY = 'Debt Payments';
const FALLBACK_CATEGORY = 'Other';
const SAVE_FAILED = 'Could not save the liability';
const SYNC_FIELDS = ['payment_amount', 'escrow_amount', 'payment_frequency'];
const MAX_SERIES_POINTS = 600;
const MAX_MONEY = 1e10;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const invalid = (): LocalHttpError => new LocalHttpError(422, 'Invalid liability data');
const notFound = (): LocalHttpError => new LocalHttpError(404, 'Liability not found');

// ---------------------------------------------------------------------------
// Validation (mirrors the pydantic models; extra fields are rejected)
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
type Check = (v: unknown) => boolean;

const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);
const text =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max;
const num =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const oneOf =
  (values: string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v);
const isBool: Check = (v) => typeof v === 'boolean';
const isInt =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** A real calendar day written exactly 'YYYY-MM-DD' (never a datetime). */
const isDay: Check = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
};

const money = num(0, MAX_MONEY);
// [check, nullable]
const SHARED: Record<string, [Check, boolean]> = {
  name: [text(1, 120), false],
  liability_type: [oneOf(TYPES), false],
  lender: [text(0, 120), true],
  interest_rate: [num(0, 1), true],
  payment_amount: [money, true],
  payment_frequency: [oneOf(FREQUENCIES), false],
  next_payment_date: [isDay, true],
  escrow_amount: [money, true],
  original_principal: [money, true],
  origination_date: [isDay, true],
  term_months: [isInt(1, 600), true],
  maturity_date: [isDay, true],
  credit_limit: [money, true],
  entity_id: [text(0, 64), true],
  linked_position_id: [text(0, 64), true],
  notes: [text(0, 2000), true],
};
const CREATE_ONLY: Record<string, [Check, boolean]> = {
  current_balance: [money, false],
  balance_as_of: [isDay, true],
  source: [oneOf(['manual', 'wizard']), false],
  // null means derive from the type (create only; the server accepts it)
  is_amortizing: [isBool, true],
};
const UPDATE_ONLY: Record<string, [Check, boolean]> = {
  expense_id: [text(0, 64), true],
  is_active: [isBool, false],
  is_amortizing: [isBool, false],
};

/**
 * Validation is strict about types: a number must be a number and a boolean a
 * boolean, with none of pydantic's lax coercion ("5" to 5). That is fine here
 * because every caller sends typed JSON; strictness only rejects malformed input.
 * Keys present in `raw` must all be known and valid; undefined counts as absent.
 */
function checkFields(raw: Raw, rules: Record<string, [Check, boolean]>): Raw {
  const out: Raw = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const rule = rules[key];
    if (!rule) throw invalid();
    if (value === null ? !rule[1] : !rule[0](value)) throw invalid();
    out[key] = value;
  }
  const origination = out['origination_date'];
  const maturity = out['maturity_date'];
  if (typeof origination === 'string' && typeof maturity === 'string' && maturity < origination)
    throw invalid();
  return out;
}

function exactKeys(raw: unknown, allowed: string[], required: string[]): Raw {
  if (!isObj(raw)) throw invalid();
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw invalid();
  for (const key of required) if (raw[key] === undefined || raw[key] === null) throw invalid();
  return raw;
}

interface PropertyInstruction {
  mode: 'link' | 'create';
  position_id?: string;
  name?: string;
  value?: number;
  cost_basis?: number | null;
  purchase_date?: string | null;
}
interface CashFlowInstruction {
  mode: 'create' | 'link' | 'none';
  category_id?: string | null;
  expense_id?: string;
}

function checkProperty(raw: unknown): PropertyInstruction {
  if (!isObj(raw)) throw invalid();
  if (raw['mode'] === 'link') {
    exactKeys(raw, ['mode', 'position_id'], ['position_id']);
    if (!text(1, 64)(raw['position_id'])) throw invalid();
    return raw as unknown as PropertyInstruction;
  }
  if (raw['mode'] !== 'create') throw invalid();
  exactKeys(raw, ['mode', 'name', 'value', 'cost_basis', 'purchase_date'], ['name', 'value']);
  const ok =
    text(1, 120)(raw['name']) &&
    money(raw['value']) &&
    (raw['cost_basis'] == null || money(raw['cost_basis'])) &&
    (raw['purchase_date'] == null || isDay(raw['purchase_date']));
  if (!ok) throw invalid();
  return raw as unknown as PropertyInstruction;
}

function checkCashFlow(raw: unknown): CashFlowInstruction {
  if (!isObj(raw)) throw invalid();
  if (raw['mode'] === 'none') {
    exactKeys(raw, ['mode'], []);
  } else if (raw['mode'] === 'create') {
    exactKeys(raw, ['mode', 'category_id'], []);
    if (raw['category_id'] != null && !text(0, 64)(raw['category_id'])) throw invalid();
  } else if (raw['mode'] === 'link') {
    exactKeys(raw, ['mode', 'expense_id'], ['expense_id']);
    if (!text(1, 64)(raw['expense_id'])) throw invalid();
  } else {
    throw invalid();
  }
  return raw as unknown as CashFlowInstruction;
}

// ---------------------------------------------------------------------------
// Dates (pure string math; no timezone conversions)
// ---------------------------------------------------------------------------

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The next due date after today: the anchor plus whole periods (one period from today with no anchor). */
function firstDueAfter(anchor: string | null, frequency: string, today: string): string {
  return dueDatesBetween(anchor ?? today, frequency, today, addDays(today, 400))[0]!;
}

// ---------------------------------------------------------------------------
// Rows and computed fields
// ---------------------------------------------------------------------------

interface LiabilityRow {
  id: string;
  entity_id: string | null;
  name: string;
  liability_type: string;
  lender: string | null;
  current_balance: number;
  balance_as_of: string;
  interest_rate: number | null;
  payment_amount: number | null;
  payment_frequency: string;
  next_payment_date: string | null;
  escrow_amount: number | null;
  original_principal: number | null;
  origination_date: string | null;
  term_months: number | null;
  maturity_date: string | null;
  credit_limit: number | null;
  is_amortizing: number;
  linked_position_id: string | null;
  expense_id: string | null;
  source: string;
  source_ref: string | null;
  is_active: number;
  closed_date: string | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SnapshotRow {
  snapshot_date: string;
  balance: number;
  source: string;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

const moneyOrNull = (value: number | null | undefined): number | null =>
  value == null ? null : round2(value);

function monthly(amount: number | null, frequency: string | null): number {
  const ppy = PERIODS_PER_YEAR[frequency ?? ''];
  if (!amount || !ppy) return 0;
  return (amount * ppy) / 12;
}

function defaultAmortizing(type: string, termMonths: number | null | undefined): boolean {
  return Boolean(AMORTIZING_BY_TYPE[type]) || (type === 'other' && Boolean(termMonths));
}

function getRow(db: ClientDatabase, id: string): LiabilityRow | undefined {
  return db.query<LiabilityRow>('SELECT * FROM liabilities WHERE id = ?', [id])[0];
}

function getSnapshots(db: ClientDatabase, id: string): SnapshotRow[] {
  return db.query<SnapshotRow>(
    'SELECT snapshot_date, balance, source FROM liability_balance_snapshots WHERE liability_id = ?',
    [id]
  );
}

const asBalanceSnapshots = (rows: SnapshotRow[]): BalanceSnapshot[] =>
  rows.map((r) => ({ snapshotDate: r.snapshot_date, balance: r.balance }));

function balanceFor(row: LiabilityRow, snapshots: SnapshotRow[], on: string): number {
  return balanceAt(
    {
      isAmortizing: Boolean(row.is_amortizing),
      interestRate: row.interest_rate,
      paymentAmount: row.payment_amount,
      paymentFrequency: row.payment_frequency || 'monthly',
      nextPaymentDate: row.next_payment_date,
      originationDate: row.origination_date,
      closedDate: row.closed_date,
    },
    asBalanceSnapshots(snapshots),
    on
  );
}

const NO_PAYOFF: AmortizationSummary = {
  payoffDate: null,
  periodsRemaining: null,
  totalInterestRemaining: null,
  neverPaysOff: false,
};

function paymentSummary(balance: number, row: LiabilityRow, today: string): AmortizationSummary {
  if (balance <= 0 || !row.payment_amount || row.payment_amount <= 0) return NO_PAYOFF;
  const frequency = row.payment_frequency || 'monthly';
  const firstDue = firstDueAfter(row.next_payment_date, frequency, today);
  return summarize(balance, row.interest_rate ?? 0, row.payment_amount, frequency, firstDue);
}

function maturityOf(row: LiabilityRow): string | null {
  if (row.maturity_date) return row.maturity_date;
  if (row.origination_date && row.term_months)
    return shift(row.origination_date, 'monthly', Number(row.term_months));
  return null;
}

function serialize(db: ClientDatabase, row: LiabilityRow, today: string): LiabilityResponse {
  const snapshots = getSnapshots(db, row.id);
  const estimated = balanceFor(row, snapshots, today);
  const summary = paymentSummary(estimated, row, today);
  const monthlyPayment = monthly(row.payment_amount, row.payment_frequency);
  const escrowMonthly = monthly(row.escrow_amount, row.payment_frequency);

  const position = row.linked_position_id
    ? db.query<{
        id: string;
        name: string | null;
        shares: number | null;
        current_price: number | null;
        contract_multiplier: number | null;
      }>(
        'SELECT id, name, shares, current_price, contract_multiplier FROM positions WHERE id = ?',
        [row.linked_position_id]
      )[0]
    : undefined;
  const expense = row.expense_id
    ? db.query<{ id: string; name: string; amount: number; frequency: string }>(
        'SELECT id, name, amount, frequency FROM budget_expenses WHERE id = ?',
        [row.expense_id]
      )[0]
    : undefined;
  const marketValue =
    position && position.current_price && position.shares
      ? position.shares * position.current_price * (position.contract_multiplier || 1)
      : 0;
  const lastReported = snapshots.reduce<string | null>(
    (max, s) => (max === null || s.snapshot_date > max ? s.snapshot_date : max),
    null
  );

  return {
    id: row.id,
    entity_id: row.entity_id,
    name: row.name,
    liability_type: row.liability_type as LiabilityResponse['liability_type'],
    lender: row.lender,
    current_balance: row.current_balance,
    balance_as_of: row.balance_as_of,
    interest_rate: row.interest_rate,
    payment_amount: row.payment_amount,
    payment_frequency: row.payment_frequency,
    next_payment_date: row.next_payment_date,
    escrow_amount: row.escrow_amount,
    original_principal: row.original_principal,
    origination_date: row.origination_date,
    term_months: row.term_months,
    maturity_date: maturityOf(row),
    credit_limit: row.credit_limit,
    is_amortizing: Boolean(row.is_amortizing),
    linked_position_id: position ? row.linked_position_id : null,
    expense_id: expense ? row.expense_id : null,
    source: row.source,
    source_ref: row.source_ref,
    is_active: Boolean(row.is_active),
    closed_date: row.closed_date,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    estimated_balance: round2(estimated),
    payoff_date: summary.payoffDate,
    periods_remaining: summary.periodsRemaining,
    total_interest_remaining: moneyOrNull(summary.totalInterestRemaining),
    monthly_payment: round2(monthlyPayment),
    monthly_cash_flow: round2(monthlyPayment + escrowMonthly),
    linked_position: position
      ? { id: position.id, name: position.name, value: round2(marketValue) }
      : null,
    linked_position_missing: Boolean(row.linked_position_id) && !position,
    expense: expense
      ? {
          id: expense.id,
          name: expense.name,
          monthly_amount: round2(monthly(expense.amount, expense.frequency)),
        }
      : null,
    expense_missing: Boolean(row.expense_id) && !expense,
    last_reported_date: lastReported,
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * SAVEPOINT, run `body`, build the result, then RELEASE; any failure (the
 * result builder included) rolls back to the savepoint only, so nothing is
 * kept and a caller's open transaction survives (nest-safe).
 * Request problems (LocalHttpError) pass through; anything else becomes a
 * fixed 500 so no SQL error text (which can carry values) ever escapes or is logged.
 */
function write<T>(
  db: ClientDatabase,
  operation: string,
  id: string,
  body: () => void,
  result: () => T
): T {
  try {
    db.execute('SAVEPOINT liab');
    body();
    const value = result();
    db.execute('RELEASE liab');
    return value;
  } catch (error) {
    try {
      db.execute('ROLLBACK TO liab');
      db.execute('RELEASE liab');
    } catch {
      // the savepoint was never created (SAVEPOINT itself failed)
    }
    if (error instanceof LocalHttpError) throw error;
    console.error(
      `Liability ${operation} failed id=${id}: ${error instanceof Error ? error.name : 'Error'}`
    );
    throw new LocalHttpError(500, SAVE_FAILED);
  }
}

// ---------------------------------------------------------------------------
// Expense helpers
// ---------------------------------------------------------------------------

function pickCategory(
  db: ClientDatabase,
  type: string,
  explicit: string | null | undefined
): string {
  if (explicit) {
    if (!db.query('SELECT 1 FROM budget_expense_categories WHERE id = ?', [explicit]).length) {
      throw new LocalHttpError(404, 'Expense category not found');
    }
    return explicit;
  }
  for (const name of [CATEGORY_BY_TYPE[type] ?? DEFAULT_CATEGORY, FALLBACK_CATEGORY]) {
    const found = db.query<{ id: string }>(
      'SELECT id FROM budget_expense_categories WHERE name = ? LIMIT 1',
      [name]
    )[0];
    if (found) return found.id;
  }
  const any = db.query<{ id: string }>(
    'SELECT id FROM budget_expense_categories ORDER BY sort_order LIMIT 1'
  )[0];
  if (any) return any.id;
  throw new LocalHttpError(422, 'No expense category exists');
}

/** Monthly (principal, interest) of the next payment, or null with no schedule. */
function mortgageSplit(row: LiabilityRow, balance: number, today: string): [number, number] | null {
  if (!row.payment_amount || balance <= 0) return null;
  const frequency = row.payment_frequency || 'monthly';
  const firstDue = firstDueAfter(row.next_payment_date, frequency, today);
  const first = schedule(
    balance,
    row.interest_rate ?? 0,
    row.payment_amount,
    frequency,
    firstDue
  )[0];
  if (!first) return null;
  const factor = periodsPerYearOf(frequency) / 12;
  return [first.principal * factor, first.interest * factor];
}

function periodsPerYearOf(frequency: string): number {
  return PERIODS_PER_YEAR[frequency] ?? 12;
}

function applyExpenseValues(
  db: ClientDatabase,
  expenseId: string,
  row: LiabilityRow,
  today: string,
  setAmount: boolean
): void {
  const balance = balanceFor(row, getSnapshots(db, row.id), today);
  const sets: Record<string, unknown> = {};
  if (setAmount) {
    sets['amount'] = round2(
      monthly(row.payment_amount, row.payment_frequency) +
        monthly(row.escrow_amount, row.payment_frequency)
    );
    sets['frequency'] = 'monthly';
    sets['end_date'] = paymentSummary(balance, row, today).payoffDate;
  }
  if (row.liability_type === 'mortgage') {
    sets['is_mortgage'] = 1;
    const split = mortgageSplit(row, balance, today);
    if (split) {
      sets['principal_portion'] = round2(split[0]);
      sets['interest_portion'] = round2(split[1]);
    }
  }
  const columns = Object.keys(sets);
  if (!columns.length) return;
  db.execute(
    `UPDATE budget_expenses SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...columns.map((c) => sets[c]), expenseId]
  );
}

function createExpense(
  db: ClientDatabase,
  row: LiabilityRow,
  categoryId: string | null | undefined,
  today: string
): string {
  if (!row.payment_amount)
    throw new LocalHttpError(422, 'A payment amount is required to create an expense');
  const entityId =
    row.entity_id && db.query('SELECT 1 FROM entities WHERE id = ?', [row.entity_id]).length
      ? row.entity_id
      : null;
  const id = crypto.randomUUID();
  db.execute(
    'INSERT INTO budget_expenses (id, entity_id, category_id, name, amount, frequency, is_active) VALUES (?, ?, ?, ?, 0, ?, 1)',
    [id, entityId, pickCategory(db, row.liability_type, categoryId), row.name, 'monthly']
  );
  applyExpenseValues(db, id, row, today, true);
  return id;
}

/** The expense must exist (404) and not belong to a different liability (409). */
function checkExpenseFree(db: ClientDatabase, expenseId: string, liabilityId: string | null): void {
  if (!db.query('SELECT 1 FROM budget_expenses WHERE id = ?', [expenseId]).length) {
    throw new LocalHttpError(404, 'Expense not found');
  }
  const taken = db.query('SELECT 1 FROM liabilities WHERE expense_id = ? AND id != ? LIMIT 1', [
    expenseId,
    liabilityId ?? '',
  ]);
  if (taken.length) throw new LocalHttpError(409, 'Expense is already linked to another liability');
}

// ---------------------------------------------------------------------------
// Property helper
// ---------------------------------------------------------------------------

function propertyAccountId(db: ClientDatabase): string {
  const existing = db.query<{ id: string }>(
    "SELECT id FROM accounts WHERE account_type = 'property' ORDER BY created_at, rowid LIMIT 1"
  )[0];
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  db.execute(
    "INSERT INTO accounts (id, name, account_type, entity_id) VALUES (?, 'Real estate', 'property', NULL)",
    [id]
  );
  return id;
}

function applyProperty(db: ClientDatabase, prop: PropertyInstruction): string {
  if (prop.mode === 'link') {
    if (!db.query('SELECT 1 FROM positions WHERE id = ?', [prop.position_id]).length) {
      throw new LocalHttpError(404, 'Position not found');
    }
    return prop.position_id!;
  }
  const accountId = propertyAccountId(db);
  const id = crypto.randomUUID();
  db.execute(
    `INSERT INTO positions (id, account_id, ticker, name, shares, cost_basis, current_price, is_fund, asset_class, position_type, purchase_date)
     VALUES (?, ?, 'RE', ?, 1.0, ?, ?, 0, 'alternative', 'real_estate', ?)`,
    [id, accountId, prop.name, prop.cost_basis ?? null, prop.value, prop.purchase_date ?? null]
  );
  return id;
}

// ---------------------------------------------------------------------------
// Query-string flags (FastAPI bool parsing)
// ---------------------------------------------------------------------------

/** 'true'/'1'/'yes'/'on' and 'false'/'0'/'no'/'off' (any case); anything else is a 422, null is the default. */
export function queryFlag(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  const v = value.toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 't'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'off', 'f'].includes(v)) return false;
  throw invalid();
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export function getLiabilities(
  db: ClientDatabase,
  entityId?: string | null,
  includeArchived = false
): LiabilityResponse[] {
  const today = clockToday();
  const where: string[] = [];
  const params: unknown[] = [];
  if (entityId) {
    where.push('entity_id = ?');
    params.push(entityId);
  }
  if (!includeArchived) where.push('is_active = 1');
  const rows = db.query<LiabilityRow>(
    `SELECT * FROM liabilities ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name, id`,
    params
  );
  return rows.map((r) => serialize(db, r, today));
}

export function getLiability(db: ClientDatabase, id: string): LiabilityResponse {
  const row = getRow(db, id);
  if (!row) throw notFound();
  return serialize(db, row, clockToday());
}

export function createLiability(
  db: ClientDatabase,
  input: CreateLiabilityInput
): LiabilityResponse {
  if (!isObj(input)) throw invalid();
  const { property: rawProperty, cash_flow: rawCashFlow, ...rest } = input as unknown as Raw;
  for (const required of ['name', 'liability_type', 'current_balance']) {
    if (rest[required] === undefined || rest[required] === null) throw invalid();
  }
  const data = checkFields(rest, { ...SHARED, ...CREATE_ONLY });
  const property = rawProperty == null ? null : checkProperty(rawProperty);
  const cashFlow = rawCashFlow == null ? null : checkCashFlow(rawCashFlow);

  const today = clockToday();
  const balanceAsOf = (data['balance_as_of'] as string | undefined) || today;
  if (balanceAsOf > today) throw new LocalHttpError(422, 'Date cannot be in the future');
  const type = data['liability_type'] as string;
  const isAmortizing =
    typeof data['is_amortizing'] === 'boolean'
      ? data['is_amortizing']
      : defaultAmortizing(type, data['term_months'] as number | null | undefined);
  const id = crypto.randomUUID();
  const val = (key: string): unknown => data[key] ?? null;

  return write(
    db,
    'create',
    id,
    () => {
      const positionId = property
        ? applyProperty(db, property)
        : (val('linked_position_id') as string | null);
      insertLiability(
        db,
        id,
        data,
        {
          balanceAsOf,
          isAmortizing,
          linkedPositionId: positionId,
          source: (data['source'] as string | undefined) ?? 'manual',
          sourceRef: null,
        },
        cashFlow,
        today
      );
    },
    () => serialize(db, getRow(db, id)!, today)
  );
}

interface InsertExtras {
  balanceAsOf: string;
  isAmortizing: boolean;
  linkedPositionId: string | null;
  source: string;
  sourceRef: string | null;
}

/** Insert the liability, its first snapshot and the optional cash flow instruction (create and convert). */
function insertLiability(
  db: ClientDatabase,
  id: string,
  data: Raw,
  extras: InsertExtras,
  cashFlow: CashFlowInstruction | null,
  today: string
): void {
  const val = (key: string): unknown => data[key] ?? null;
  const type = data['liability_type'] as string;
  db.execute(
    `INSERT INTO liabilities (id, entity_id, name, liability_type, lender, current_balance, balance_as_of, interest_rate,
       payment_amount, payment_frequency, next_payment_date, escrow_amount, original_principal, origination_date, term_months,
       maturity_date, credit_limit, is_amortizing, linked_position_id, source, source_ref, is_active, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      id,
      val('entity_id'),
      data['name'],
      type,
      val('lender'),
      data['current_balance'],
      extras.balanceAsOf,
      val('interest_rate'),
      val('payment_amount'),
      data['payment_frequency'] ?? 'monthly',
      val('next_payment_date'),
      val('escrow_amount'),
      val('original_principal'),
      val('origination_date'),
      val('term_months'),
      val('maturity_date'),
      val('credit_limit'),
      extras.isAmortizing ? 1 : 0,
      extras.linkedPositionId,
      extras.source,
      extras.sourceRef,
      val('notes'),
    ]
  );
  db.execute(
    'INSERT INTO liability_balance_snapshots (id, liability_id, snapshot_date, balance, source) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), id, extras.balanceAsOf, data['current_balance'], extras.source]
  );
  if (cashFlow?.mode === 'create') {
    const expenseId = createExpense(db, getRow(db, id)!, cashFlow.category_id, today);
    db.execute(
      'UPDATE liabilities SET expense_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [expenseId, id]
    );
  } else if (cashFlow?.mode === 'link') {
    checkExpenseFree(db, cashFlow.expense_id!, null);
    db.execute(
      'UPDATE liabilities SET expense_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [cashFlow.expense_id, id]
    );
    if (type === 'mortgage')
      applyExpenseValues(db, cashFlow.expense_id!, getRow(db, id)!, today, false);
  }
}

export function updateLiability(
  db: ClientDatabase,
  id: string,
  input: UpdateLiabilityInput,
  syncExpense = true
): LiabilityResponse {
  if (!isObj(input)) throw invalid();
  const changes = checkFields(input, { ...SHARED, ...UPDATE_ONLY });
  const row = getRow(db, id);
  if (!row) throw notFound();
  const today = clockToday();

  const archive = changes['is_active'] as boolean | undefined;
  const hasRelink = 'expense_id' in changes;
  const relink = changes['expense_id'] as string | null | undefined;
  delete changes['is_active'];
  delete changes['expense_id'];
  const syncNeeded = SYNC_FIELDS.some(
    (f) => f in changes && changes[f] !== (row as unknown as Raw)[f]
  );

  return write(
    db,
    'update',
    id,
    () => {
      if (
        changes['linked_position_id'] &&
        !db.query('SELECT 1 FROM positions WHERE id = ?', [changes['linked_position_id']]).length
      ) {
        throw new LocalHttpError(404, 'Position not found');
      }
      if (relink != null) checkExpenseFree(db, relink, id);
      if ('liability_type' in changes && !('is_amortizing' in changes)) {
        const term =
          'term_months' in changes ? (changes['term_months'] as number | null) : row.term_months;
        changes['is_amortizing'] = defaultAmortizing(changes['liability_type'] as string, term);
      }
      const sets: Record<string, unknown> = { ...changes };
      if ('is_amortizing' in sets) sets['is_amortizing'] = sets['is_amortizing'] ? 1 : 0;
      if (hasRelink) sets['expense_id'] = relink ?? null;
      if (archive === false && row.is_active) {
        sets['is_active'] = 0;
        sets['closed_date'] = row.closed_date || today;
      } else if (archive === true && !row.is_active) {
        sets['is_active'] = 1;
        sets['closed_date'] = null;
      }
      const columns = Object.keys(sets);
      const assignments = [...columns.map((c) => `${c} = ?`), 'updated_at = CURRENT_TIMESTAMP'];
      db.execute(`UPDATE liabilities SET ${assignments.join(', ')} WHERE id = ?`, [
        ...columns.map((c) => sets[c]),
        id,
      ]);
      const fresh = getRow(db, id)!;
      if (relink != null) {
        if (fresh.liability_type === 'mortgage')
          applyExpenseValues(db, relink, fresh, today, false);
      } else if (syncExpense && syncNeeded && fresh.expense_id && !hasRelink) {
        if (db.query('SELECT 1 FROM budget_expenses WHERE id = ?', [fresh.expense_id]).length) {
          if (!fresh.payment_amount || fresh.payment_amount <= 0) {
            throw new LocalHttpError(
              422,
              'A payment amount is required to sync the linked expense'
            );
          }
          applyExpenseValues(db, fresh.expense_id, fresh, today, true);
        }
      }
    },
    () => serialize(db, getRow(db, id)!, today)
  );
}

export function deleteLiability(
  db: ClientDatabase,
  id: string,
  deleteExpense = false
): DeleteLiabilityResult {
  const row = getRow(db, id);
  if (!row) throw notFound();
  let expenseDeleted = false;
  return write(
    db,
    'delete',
    id,
    () => {
      if (
        deleteExpense &&
        row.expense_id &&
        db.query('SELECT 1 FROM budget_expenses WHERE id = ?', [row.expense_id]).length
      ) {
        db.execute('DELETE FROM budget_expenses WHERE id = ?', [row.expense_id]);
        expenseDeleted = true;
      }
      db.execute('DELETE FROM liability_balance_snapshots WHERE liability_id = ?', [id]);
      db.execute('DELETE FROM liabilities WHERE id = ?', [id]);
    },
    () => ({ deleted: true, id, expense_deleted: expenseDeleted })
  );
}

export function recordLiabilityBalance(
  db: ClientDatabase,
  id: string,
  input: RecordBalanceInput
): LiabilityResponse {
  const body = exactKeys(input, ['balance', 'as_of'], ['balance']);
  if (!money(body['balance']) || (body['as_of'] != null && !isDay(body['as_of']))) throw invalid();
  const today = clockToday();
  const day = (body['as_of'] as string | null | undefined) || today;
  if (day > today) throw new LocalHttpError(422, 'Date cannot be in the future');
  if (!getRow(db, id)) throw notFound();
  const balance = body['balance'] as number;

  return write(
    db,
    'balance',
    id,
    () => {
      const existing = db.query<{ id: string }>(
        'SELECT id FROM liability_balance_snapshots WHERE liability_id = ? AND snapshot_date = ?',
        [id, day]
      )[0];
      if (existing) {
        db.execute(
          "UPDATE liability_balance_snapshots SET balance = ?, source = 'manual' WHERE id = ?",
          [balance, existing.id]
        );
      } else {
        db.execute(
          "INSERT INTO liability_balance_snapshots (id, liability_id, snapshot_date, balance, source) VALUES (?, ?, ?, ?, 'manual')",
          [crypto.randomUUID(), id, day, balance]
        );
      }
      const newest = db.query<{ d: string }>(
        'SELECT MAX(snapshot_date) AS d FROM liability_balance_snapshots WHERE liability_id = ?',
        [id]
      )[0]!.d;
      if (day === newest) {
        db.execute(
          'UPDATE liabilities SET current_balance = ?, balance_as_of = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [balance, day, id]
        );
      }
    },
    () => serialize(db, getRow(db, id)!, today)
  );
}

export function getLiabilityHistory(db: ClientDatabase, id: string): LiabilityHistoryResponse {
  const today = clockToday();
  const row = getRow(db, id);
  if (!row) throw notFound();
  const snapshots = getSnapshots(db, id).sort((a, b) =>
    a.snapshot_date < b.snapshot_date ? -1 : a.snapshot_date > b.snapshot_date ? 1 : 0
  );
  const reported = snapshots.map((s) => ({
    date: s.snapshot_date,
    balance: round2(s.balance),
    source: s.source,
  }));
  const dates = snapshots.length
    ? monthEnds(snapshots[0]!.snapshot_date, today, MAX_SERIES_POINTS)
    : [];
  dates.push(today);
  const series = dates.map((d) => ({
    date: d,
    balance: round2(balanceFor(row, snapshots, d)),
    source: null,
  }));
  return { liability_id: id, reported, series };
}

// ---------------------------------------------------------------------------
// Conversion of an existing real estate position (mirror of
// service.convert_position / revert_conversion; design section 8).
//
// Position rows are read with SELECT * and written back value for value, and
// these UPDATEs deliberately leave positions.updated_at alone, so a restored
// row is exactly the original.
// ---------------------------------------------------------------------------

const CONVERTED = 'converted_position';
const MODES = ['property_value', 'equity', 'loan'];
// What a cash_flow link can change on an existing expense (the mortgage split at
// link time, then amount, frequency and end date through a later sync).
const EXPENSE_RESTORE = [
  'id',
  'amount',
  'frequency',
  'end_date',
  'is_mortgage',
  'principal_portion',
  'interest_portion',
  'updated_at',
];
const MORTGAGE_RULES: Record<string, [Check, boolean]> = {
  name: SHARED['name']!,
  lender: SHARED['lender']!,
  current_balance: [money, true],
  balance_as_of: [isDay, true],
  interest_rate: SHARED['interest_rate']!,
  payment_amount: SHARED['payment_amount']!,
  payment_frequency: SHARED['payment_frequency']!,
  next_payment_date: SHARED['next_payment_date']!,
  escrow_amount: SHARED['escrow_amount']!,
  original_principal: SHARED['original_principal']!,
  origination_date: SHARED['origination_date']!,
  term_months: SHARED['term_months']!,
  maturity_date: SHARED['maturity_date']!,
  entity_id: SHARED['entity_id']!,
  notes: SHARED['notes']!,
};

type PositionRow = Record<string, unknown> & { id: string };

interface ConversionDetail {
  mode: string;
  position_before: PositionRow;
  set_current_price?: number;
  linked_expense?: Raw | null;
  created: { account_id: string | null; position_id: string | null; expense_id: string | null };
}

function rawPosition(db: ClientDatabase, id: string): PositionRow | undefined {
  return db.query<PositionRow>('SELECT * FROM positions WHERE id = ?', [id])[0];
}

/** Market value as the positions code computes it. */
function rawValue(row: Raw): number {
  const price = row['current_price'] as number | null;
  const shares = row['shares'] as number | null;
  if (!price || !shares) return 0;
  return shares * price * ((row['contract_multiplier'] as number | null) || 1);
}

function positionView(
  db: ClientDatabase,
  id: string
): { id: string; name: string | null; value: number } | null {
  const row = rawPosition(db, id);
  if (!row) return null;
  return { id: row.id, name: (row['name'] as string | null) ?? null, value: round2(rawValue(row)) };
}

const isRealEstate = (row: Raw): boolean =>
  row['position_type'] === 'real_estate' || row['ticker'] === 'RE';

function checkConvert(raw: unknown): {
  positionId: string;
  mode: string;
  homeValue: number | null;
  addHome: PropertyInstruction | null;
  mortgage: Raw;
  cashFlow: CashFlowInstruction | null;
} {
  const body = exactKeys(
    raw,
    ['position_id', 'mode', 'home_value', 'add_home', 'mortgage', 'cash_flow'],
    ['position_id', 'mode', 'mortgage']
  );
  if (!text(1, 64)(body['position_id']) || !oneOf(MODES)(body['mode'])) throw invalid();
  if (!isObj(body['mortgage'])) throw invalid();
  const mortgage = checkFields(body['mortgage'], MORTGAGE_RULES);
  const homeValue = body['home_value'] ?? null;
  if (homeValue !== null && !money(homeValue)) throw invalid();
  const addHome =
    body['add_home'] == null
      ? null
      : checkProperty({ ...(body['add_home'] as Raw), mode: 'create' });
  if (isObj(body['add_home']) && 'mode' in body['add_home']) throw invalid();
  const mode = body['mode'] as string;
  if ((mode === 'equity') !== (homeValue !== null)) throw invalid();
  if (addHome && mode !== 'loan') throw invalid();
  if (mode !== 'loan' && mortgage['current_balance'] == null) throw invalid();
  return {
    positionId: body['position_id'] as string,
    mode,
    homeValue: homeValue as number | null,
    addHome,
    mortgage,
    cashFlow: body['cash_flow'] == null ? null : checkCashFlow(body['cash_flow']),
  };
}

export function convertPosition(
  db: ClientDatabase,
  input: ConvertPositionInput
): ConvertPositionResult {
  const { positionId, mode, homeValue, addHome, mortgage, cashFlow } = checkConvert(input);
  const today = clockToday();
  const balanceAsOf = (mortgage['balance_as_of'] as string | null | undefined) || today;
  if (balanceAsOf > today) throw new LocalHttpError(422, 'Date cannot be in the future');
  const id = crypto.randomUUID();
  const created: ConversionDetail['created'] = {
    account_id: null,
    position_id: null,
    expense_id: null,
  };

  return write(
    db,
    'convert',
    positionId,
    () => {
      const before = rawPosition(db, positionId);
      if (!before) throw new LocalHttpError(404, 'Position not found');
      if (!isRealEstate(before))
        throw new LocalHttpError(409, 'Only real estate positions can be converted');
      if (
        db.query('SELECT 1 FROM liabilities WHERE source = ? AND source_ref = ? LIMIT 1', [
          CONVERTED,
          positionId,
        ]).length
      ) {
        throw new LocalHttpError(409, 'This position is already converted');
      }
      if (
        db.query('SELECT 1 FROM liabilities WHERE linked_position_id = ? LIMIT 1', [positionId])
          .length
      ) {
        throw new LocalHttpError(409, 'This position is already linked to a debt');
      }
      const detail: ConversionDetail = { mode, position_before: before, created };
      const data: Raw = { ...mortgage, name: mortgage['name'] ?? 'Mortgage' };
      let linked: string | null = positionId;
      if (mode === 'equity') {
        const units =
          Number(before['shares'] || 0) * Number((before['contract_multiplier'] as number) || 1);
        if (units === 0) throw new LocalHttpError(409, 'This position has no units to price');
        const price = homeValue! / units;
        db.execute('UPDATE positions SET current_price = ? WHERE id = ?', [price, positionId]);
        detail.set_current_price = price;
      } else if (mode === 'loan') {
        if (
          db.query('SELECT 1 FROM position_lots WHERE position_id = ? LIMIT 1', [positionId]).length
        ) {
          throw new LocalHttpError(
            409,
            'This position has tax lots and cannot be converted to a loan'
          );
        }
        if (data['current_balance'] == null)
          data['current_balance'] = round2(Math.abs(rawValue(before)));
        db.execute('DELETE FROM positions WHERE id = ?', [positionId]);
        linked = null;
        if (addHome) {
          const hadAccount = db.query(
            "SELECT 1 FROM accounts WHERE account_type = 'property' LIMIT 1"
          ).length;
          linked = applyProperty(db, addHome);
          created.position_id = linked;
          if (!hadAccount) {
            created.account_id = db.query<{ account_id: string }>(
              'SELECT account_id FROM positions WHERE id = ?',
              [linked]
            )[0]!.account_id;
          }
        }
      }
      if (cashFlow?.mode === 'link') {
        detail.linked_expense =
          db.query<Raw>(`SELECT ${EXPENSE_RESTORE.join(', ')} FROM budget_expenses WHERE id = ?`, [
            cashFlow.expense_id,
          ])[0] ?? null;
      }
      data['liability_type'] = 'mortgage';
      insertLiability(
        db,
        id,
        data,
        {
          balanceAsOf,
          isAmortizing: true,
          linkedPositionId: linked,
          source: CONVERTED,
          sourceRef: positionId,
        },
        cashFlow,
        today
      );
      if (cashFlow?.mode === 'create') created.expense_id = getRow(db, id)!.expense_id;
      db.execute('UPDATE liabilities SET source_detail = ? WHERE id = ?', [
        JSON.stringify(detail),
        id,
      ]);
    },
    () => ({
      liability: serialize(db, getRow(db, id)!, today),
      position: mode === 'loan' ? null : positionView(db, positionId),
      created,
    })
  );
}

function loadDetail(raw: string | null): ConversionDetail {
  const refuse = new LocalHttpError(409, 'This conversion cannot be undone');
  let detail: unknown;
  try {
    detail = JSON.parse(raw ?? '');
  } catch {
    throw refuse;
  }
  if (!isObj(detail) || !MODES.includes(detail['mode'] as string)) throw refuse;
  const before = detail['position_before'];
  if (!isObj(before) || !before['id'] || !isObj(detail['created'])) throw refuse;
  return detail as unknown as ConversionDetail;
}

/**
 * Undo a conversion exactly, or refuse (409) without changing anything. The
 * post-conversion edit rule is the server's: see service.revert_conversion.
 */
export function revertConversion(db: ClientDatabase, id: string): RevertConversionResult {
  const row = db.query<LiabilityRow & { source_detail: string | null }>(
    'SELECT * FROM liabilities WHERE id = ?',
    [id]
  )[0];
  if (!row) throw notFound();
  if (row.source !== CONVERTED) throw new LocalHttpError(409, 'Only converted debts can be undone');

  return write(
    db,
    'revert',
    id,
    () => {
      const detail = loadDetail(row.source_detail);
      const before = detail.position_before;
      const current = rawPosition(db, String(before.id));
      if (detail.mode === 'equity') {
        if (!current)
          throw new LocalHttpError(
            409,
            'The property was removed after the conversion, so it cannot be undone'
          );
        if (current['current_price'] !== detail.set_current_price)
          throw new LocalHttpError(
            409,
            'The property value changed after the conversion, so it cannot be undone'
          );
        db.execute('UPDATE positions SET current_price = ? WHERE id = ?', [
          before['current_price'] ?? null,
          before.id,
        ]);
      } else if (detail.mode === 'loan') {
        if (current) throw new LocalHttpError(409, 'The original position already exists');
        const known = new Set(
          db.query<{ name: string }>('PRAGMA table_info(positions)').map((c) => c.name)
        );
        const columns = Object.keys(before);
        if (!columns.every((c) => known.has(c)))
          throw new LocalHttpError(409, 'This conversion cannot be undone');
        if (!db.query('SELECT 1 FROM accounts WHERE id = ?', [before['account_id']]).length)
          throw new LocalHttpError(409, 'The account that held this position no longer exists');
        // Column names come from the table's own schema (checked above), never from input.
        db.execute(
          `INSERT INTO positions (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((c) => before[c] ?? null)
        );
      }
      restoreLinkedExpense(db, row, detail.linked_expense);
      deleteCreated(db, detail.created, id);
      db.execute('DELETE FROM liability_balance_snapshots WHERE liability_id = ?', [id]);
      db.execute('DELETE FROM liabilities WHERE id = ?', [id]);
    },
    () => ({ reverted: true })
  );
}

/**
 * Put back an expense a cash_flow link (and later syncs) changed, unless this
 * debt no longer links it or another debt does (see service._restore_linked_expense).
 */
function restoreLinkedExpense(
  db: ClientDatabase,
  row: LiabilityRow,
  before: Raw | null | undefined
): void {
  if (!isObj(before) || !before['id']) return;
  const expenseId = before['id'] as string;
  if (row.expense_id !== expenseId) return;
  if (
    db.query('SELECT 1 FROM liabilities WHERE expense_id = ? AND id != ? LIMIT 1', [
      expenseId,
      row.id,
    ]).length
  ) {
    return;
  }
  const columns = EXPENSE_RESTORE.filter((c) => c !== 'id');
  db.execute(
    `UPDATE budget_expenses SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((c) => before[c] ?? null), expenseId]
  );
}

/**
 * Delete what the conversion created and still exists (see service._delete_created):
 * the home position is kept while another debt links it, the account while it
 * holds positions.
 */
function deleteCreated(db: ClientDatabase, created: ConversionDetail['created'], id: string): void {
  if (
    created.expense_id &&
    !db.query('SELECT 1 FROM liabilities WHERE expense_id = ? AND id != ? LIMIT 1', [
      created.expense_id,
      id,
    ]).length
  ) {
    db.execute('DELETE FROM budget_expenses WHERE id = ?', [created.expense_id]);
  }
  if (
    created.position_id &&
    !db.query('SELECT 1 FROM liabilities WHERE linked_position_id = ? AND id != ? LIMIT 1', [
      created.position_id,
      id,
    ]).length
  ) {
    db.execute('DELETE FROM position_lots WHERE position_id = ?', [created.position_id]);
    db.execute('DELETE FROM positions WHERE id = ?', [created.position_id]);
  }
  if (
    created.account_id &&
    !db.query('SELECT 1 FROM positions WHERE account_id = ? LIMIT 1', [created.account_id]).length
  ) {
    db.execute('DELETE FROM accounts WHERE id = ?', [created.account_id]);
  }
}

// ---------------------------------------------------------------------------
// Dashboard payload (mirror of liabilities.service.dashboard_block). Read only.
// ---------------------------------------------------------------------------

/**
 * Liabilities part of /api/dashboard/data: the summary fields to merge and the
 * history with `liabilities` and `net_worth` added. A filtered response only
 * says liabilities_included false and leaves history untouched. Archived debts
 * count in history until their closed_date but are not listed or totalled today.
 */
export function dashboardLiabilities<H extends { date: string; total: number | null }>(
  db: ClientDatabase,
  filtered: boolean,
  history: H[],
  totalValue: number
): DashboardLiabilities<H> {
  if (filtered) return { summary: { liabilities_included: false }, history };
  const today = clockToday();
  const rows = db.query<LiabilityRow>('SELECT * FROM liabilities ORDER BY name, id');
  const snapshots = new Map<string, SnapshotRow[]>(rows.map((r) => [r.id, []]));
  for (const s of db.query<SnapshotRow & { liability_id: string }>(
    'SELECT liability_id, snapshot_date, balance, source FROM liability_balance_snapshots'
  )) {
    snapshots.get(s.liability_id)?.push(s);
  }
  for (const snaps of snapshots.values()) {
    snaps.sort((a, b) =>
      a.snapshot_date < b.snapshot_date ? -1 : a.snapshot_date > b.snapshot_date ? 1 : 0
    );
  }
  const wanted = rows.map((r) => r.linked_position_id).filter((id): id is string => Boolean(id));
  const positions = new Set(
    wanted.length
      ? db
          .query<{ id: string }>(
            `SELECT id FROM positions WHERE id IN (${wanted.map(() => '?').join(',')})`,
            wanted
          )
          .map((p) => p.id)
      : []
  );
  let total = 0;
  const entries = rows
    .filter((r) => r.is_active)
    .map((r) => {
      const snaps = snapshots.get(r.id)!;
      const balance = balanceFor(r, snaps, today);
      total += balance;
      return {
        id: r.id,
        name: r.name,
        liability_type: r.liability_type as LiabilityResponse['liability_type'],
        balance: round2(balance),
        interest_rate: r.interest_rate,
        payment_amount: r.payment_amount,
        payment_frequency: r.payment_frequency,
        payoff_date: paymentSummary(balance, r, today).payoffDate,
        linked_position_id:
          r.linked_position_id && positions.has(r.linked_position_id) ? r.linked_position_id : null,
        entity_id: r.entity_id,
        is_amortizing: Boolean(r.is_amortizing),
        last_reported_date: snaps.length
          ? snaps[snaps.length - 1]!.snapshot_date.slice(0, 10)
          : null,
      };
    });
  const owed = round2(total);
  return {
    summary: {
      liabilities_included: true,
      liabilities_total: owed,
      net_worth: round2(totalValue - owed),
      liabilities: entries,
    },
    history: history.map((h) => {
      const day = h.date.slice(0, 10);
      const debt = round2(
        rows.reduce((sum, r) => sum + balanceFor(r, snapshots.get(r.id)!, day), 0)
      );
      return { ...h, liabilities: debt, net_worth: round2((h.total ?? 0) - debt) };
    }),
  };
}
