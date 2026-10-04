/**
 * Browser-SQLite smart import, read side and settings (mirror of
 * src/smart_import/service.py, src/smart_import/settings_store.py and the
 * data routes of src/api/smart_import.py). Same validation, status codes,
 * fixed error bodies and response shapes. Browser differences: there is no
 * demo protection (the hosted demo is a private copy in the browser), and a
 * float such as 12.0 cannot be told from the integer 12 once parsed.
 *
 * Conventions: calendar dates are local 'YYYY-MM-DD' (utils/clock.ts);
 * datetimes are returned as ISO text without a timezone, like the server
 * ('YYYY-MM-DDTHH:MM:SS'); SQL is parameterized only; nothing here logs
 * statement content (failures log the operation and the error type only).
 */

import type { ClientDatabase } from './client-database';
import { LocalHttpError } from './local-error';
import { connectionExists } from './local-connections-store';
import { today as clockToday } from '@/utils/clock';
import type {
  ApplyRecurring,
  ApplyRequest,
  ApplyResponse,
  ApplyRule,
  ApplyStatement,
  ApplyTxn,
  MerchantRuleResponse,
  PreviewRequest,
  PreviewResponse,
  SmartImportContext,
  SmartImportDeleted,
  SmartImportSettings,
  SmartImportSettingsUpdate,
  SmartImportSummary,
  SmartImportTransactionsDeleted,
  SmartImportUndoResponse,
  SpendingSummary,
} from '@/types/api';

const HISTORY_DAYS = 400;
const MAX_STORED_KEY_CHARS = 120;
const IN_CHUNK = 500;
const DEBT_KINDS = ['credit_card', 'loan'];
const SETTINGS_KEY = 'smart_import';
const RETENTION_CHOICES = [0, 12, 24, 36];
const MAX_CSV_LAYOUTS = 50;
const MAX_ACCOUNT_LABELS = 200;
const MAX_HEADER_NAME_CHARS = 200;
const MAX_ACCOUNT_LABEL_CHARS = 120;
const MAPPABLE_FIELDS = ['date', 'description', 'amount', 'debit', 'credit', 'type', 'balance'];
const ACCOUNT_KINDS = ['checking', 'savings', 'credit_card', 'loan', 'unknown'] as const;
const MAX_PREVIEW_STATEMENTS = 12;
const MAX_PREVIEW_KEYS = 10_000;

// ---------------------------------------------------------------------------
// Errors: the fixed catalog entries these routes use (src/smart_import/errors.py)
// ---------------------------------------------------------------------------

const CATALOG: Record<string, [number, string]> = {
  bad_request: [422, 'The request could not be read.'],
  rule_not_found: [404, 'Rule not found.'],
  not_smart_import: [404, 'This is not a smart import.'],
  import_not_found: [404, 'Import not found. It may have already been undone.'],
  category_not_found: [404, 'Category not found.'],
  liability_not_found: [404, 'Debt not found.'],
  expense_not_found: [404, 'Expense not found.'],
  connection_not_found: [404, 'Connection not found.'],
  // Connector codes the browser connection store and the B6 composites raise
  // (src/connectors/errors.py, same status and detail).
  connection_limit: [
    422,
    'This profile already has the maximum of 10 connections. Disconnect one first.',
  ],
  reconnect_needed: [409, 'The provider no longer accepts this connection. Reconnect to continue.'],
  payment_required: [409, 'The provider reports that the subscription needs attention.'],
  provider_rate_limited: [429, 'The provider asked for fewer requests. Try again tomorrow.'],
  quota_reached: [429, 'This connection has reached its daily sync limit. Try again tomorrow.'],
  connector_disabled: [503, 'This connection type is not enabled here.'],
  claim_not_saved: [
    500,
    'Your setup token was used but the connection could not be saved. Create a ' +
      'new setup token in SimpleFIN and try again.',
  ],
  claim_timeout: [
    504,
    'The setup token may have been used. If connecting again fails, create a new one.',
  ],
  // A v2 call the browser could not finish (no answer, or the request timed out).
  provider_timeout: [504, 'The provider took too long to respond.'],
  provider_unavailable: [502, 'The provider could not be reached.'],
  provider_bad_response: [502, 'The provider returned an unusable response.'],
  host_not_allowed: [422, 'This connection address is not allowed.'],
  // Browser only: the key store or WebCrypto failed; the connection is unchanged.
  storage_unavailable: [
    503,
    'This browser could not open its saved connection details. Try again in a moment.',
  ],
  // Browser only: one provider call per connection at a time in this tab (plan B6).
  connection_busy: [409, 'This connection is busy with another request. Try again in a moment.'],
  server_error: [500, 'Something went wrong.'],
  save_failed: [500, 'The change could not be saved.'],
};

/** A smart import failure: status and fixed detail from the catalog, never row content. */
export class SmartImportHttpError extends LocalHttpError {
  readonly errorType: string;
  constructor(errorType: string) {
    const [status, detail] = CATALOG[errorType] ?? [500, 'Something went wrong.'];
    super(status, detail, { error_type: errorType, detail });
    this.errorType = errorType;
  }
  body(): { error_type: string; detail: string } {
    return { error_type: this.errorType, detail: this.message };
  }
}

const fail = (errorType: string): SmartImportHttpError => new SmartImportHttpError(errorType);

/** Run `fn`; any unexpected failure becomes a fixed error carrying no content. */
function guarded<T>(operation: string, errorType: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LocalHttpError) throw error;
    console.error(
      `smart_import_${operation}_failed error_type=${error instanceof Error ? error.name : 'Error'}`
    );
    throw fail(errorType);
  }
}

/**
 * SAVEPOINT, run `body`, build the result, then RELEASE; any failure rolls
 * back to the savepoint only (nest-safe). The result is built before RELEASE.
 */
function write<T>(db: ClientDatabase, operation: string, body: () => T): T {
  let started = false;
  try {
    db.execute('SAVEPOINT smart_import');
    started = true;
    const value = body();
    db.execute('RELEASE smart_import');
    return value;
  } catch (error) {
    if (started) {
      try {
        db.execute('ROLLBACK TO smart_import');
        db.execute('RELEASE smart_import');
      } catch {
        // nothing left to undo
      }
    }
    if (error instanceof LocalHttpError) throw error;
    console.error(
      `smart_import_${operation}_failed error_type=${error instanceof Error ? error.name : 'Error'}`
    );
    throw fail('save_failed');
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Length in code points, like Python's len() (pydantic counts characters, not UTF-16 units). */
const chars = (s: string): number => (s.length <= 1 ? s.length : Array.from(s).length);
const textBetween = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && chars(v) >= min && chars(v) <= max;
const truncate = (s: string, max: number): string =>
  chars(s) <= max ? s : Array.from(s).slice(0, max).join('');

/** Code point order, which is Python's str order and SQLite's BINARY collation. */
function cmp(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

/** Datetime text as the server returns it: 'T' separator, no timezone suffix. */
function isoOut(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.replace(' ', 'T').replace(/Z$/, '');
}

/** SQL expression that sorts mixed 'T' / space datetime text consistently. */
const sortable = (column: string): string => `replace(${column}, 'T', ' ')`;

/**
 * Newest first. One Apply writes every import with the same timestamp here, while the
 * server's per-row timestamps follow insertion order; rowid (insertion order) breaks the
 * tie the same way. Random ids never decide the order.
 */
const newestFirst = (column: string, table = ''): string =>
  `${sortable(table + column)} DESC, ${table}rowid DESC`;

function* chunks<T>(items: T[]): Generator<T[]> {
  for (let start = 0; start < items.length; start += IN_CHUNK) {
    yield items.slice(start, start + IN_CHUNK);
  }
}

const placeholders = (n: number): string => Array(n).fill('?').join(',');

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

/** 'YYYY-MM-DD' minus `days`, computed on the calendar (no timezone involved). */
function minusDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d - days));
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}`;
}

/** Stable JSON with sorted keys, like Python's json.dumps(sort_keys=True). */
function sortedJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (isObj(v)) {
      const out: Raw = {};
      for (const key of Object.keys(v).sort(cmp)) out[key] = sort(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

// ---------------------------------------------------------------------------
// Settings (mirror of settings_store.py)
// ---------------------------------------------------------------------------

const LAYOUT_SIGNATURE = /^[0-9a-f]{64}$/;
const ACCOUNT_KEY = /^(acct|label):[^\x00-\x1f\x7f]{1,190}$/u; // eslint-disable-line no-control-regex

function validMapping(mapping: unknown): mapping is Record<string, string> {
  if (!isObj(mapping)) return false;
  const entries = Object.entries(mapping);
  return (
    entries.length > 0 &&
    entries.length <= MAPPABLE_FIELDS.length &&
    entries.every(
      ([k, v]) => MAPPABLE_FIELDS.includes(k) && textBetween(v, 1, MAX_HEADER_NAME_CHARS)
    )
  );
}

function cleanLayouts(raw: unknown): SmartImportSettings['csv_layouts'] {
  if (!isObj(raw)) return {};
  const clean: SmartImportSettings['csv_layouts'] = {};
  for (const [sig, mapping] of Object.entries(raw)) {
    if (LAYOUT_SIGNATURE.test(sig) && validMapping(mapping)) clean[sig] = { ...mapping };
  }
  return Object.fromEntries(Object.entries(clean).slice(0, MAX_CSV_LAYOUTS));
}

function cleanAccounts(raw: unknown): SmartImportSettings['accounts'] {
  if (!isObj(raw)) return {};
  const clean: Record<string, string> = {};
  for (const [key, label] of Object.entries(raw)) {
    if (ACCOUNT_KEY.test(key) && textBetween(label, 1, MAX_ACCOUNT_LABEL_CHARS)) clean[key] = label;
  }
  return Object.fromEntries(Object.entries(clean).slice(0, MAX_ACCOUNT_LABELS));
}

/** The five known settings from a stored value, defaults for anything invalid. */
function sanitize(stored: unknown): SmartImportSettings {
  const settings: SmartImportSettings = {
    retention_months: 24,
    ai_enabled: false,
    pdf_ai_enabled: false,
    csv_layouts: {},
    accounts: {},
  };
  if (!isObj(stored)) return settings;
  const months = stored.retention_months;
  if (
    typeof months === 'number' &&
    Number.isInteger(months) &&
    RETENTION_CHOICES.includes(months)
  ) {
    settings.retention_months = months as SmartImportSettings['retention_months'];
  }
  settings.ai_enabled = stored.ai_enabled === true;
  settings.pdf_ai_enabled = stored.pdf_ai_enabled === true;
  settings.csv_layouts = cleanLayouts(stored.csv_layouts);
  settings.accounts = cleanAccounts(stored.accounts);
  return settings;
}

function readSettings(db: ClientDatabase): SmartImportSettings {
  const row = db.query<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', [
    SETTINGS_KEY,
  ])[0];
  if (!row || !row.value) return sanitize(null);
  try {
    return sanitize(JSON.parse(row.value));
  } catch {
    return sanitize(null);
  }
}

/** Validate a PUT body like SettingsUpdate: known keys only, none null, every value checked. */
function parseSettingsUpdate(body: unknown): SmartImportSettingsUpdate {
  if (!isObj(body)) throw fail('bad_request');
  const out: SmartImportSettingsUpdate = {};
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'retention_months':
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          !RETENTION_CHOICES.includes(value)
        ) {
          throw fail('bad_request');
        }
        out.retention_months = value as SmartImportSettings['retention_months'];
        break;
      case 'ai_enabled':
      case 'pdf_ai_enabled':
        if (typeof value !== 'boolean') throw fail('bad_request');
        out[key] = value;
        break;
      case 'csv_layouts': {
        if (!isObj(value) || Object.keys(value).length > MAX_CSV_LAYOUTS) throw fail('bad_request');
        for (const [sig, mapping] of Object.entries(value)) {
          if (!LAYOUT_SIGNATURE.test(sig) || !validMapping(mapping)) throw fail('bad_request');
        }
        out.csv_layouts = value as SmartImportSettings['csv_layouts'];
        break;
      }
      case 'accounts': {
        if (!isObj(value) || Object.keys(value).length > MAX_ACCOUNT_LABELS)
          throw fail('bad_request');
        for (const [k, label] of Object.entries(value)) {
          if (!ACCOUNT_KEY.test(k) || !textBetween(label, 1, MAX_ACCOUNT_LABEL_CHARS)) {
            throw fail('bad_request');
          }
        }
        out.accounts = value as SmartImportSettings['accounts'];
        break;
      }
      default:
        throw fail('bad_request'); // extra keys are rejected
    }
  }
  return out;
}

export function getSmartImportSettings(db: ClientDatabase): SmartImportSettings {
  return guarded('get_settings', 'server_error', () => readSettings(db));
}

export function putSmartImportSettings(db: ClientDatabase, body: unknown): SmartImportSettings {
  const changes = parseSettingsUpdate(body);
  return write(db, 'put_settings', () => {
    const settings = readSettings(db);
    if (Object.keys(changes).length === 0) return settings; // {} writes nothing
    Object.assign(settings, changes);
    db.execute(
      `INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = 0, updated_at = excluded.updated_at`,
      [SETTINGS_KEY, sortedJson(settings), new Date().toISOString()]
    );
    return settings;
  });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface CategoryRow {
  id: string;
  name: string;
}

function categories(db: ClientDatabase): CategoryRow[] {
  return db.query<CategoryRow>(
    'SELECT id, name FROM budget_expense_categories ORDER BY sort_order, name, id'
  );
}

interface RuleRow {
  id: string;
  merchant_key: string;
  category_id: string | null;
  kind: string | null;
  hits: number;
  source: string;
  updated_at: string | null;
}

function ruleRows(db: ClientDatabase): RuleRow[] {
  return db.query<RuleRow>(
    'SELECT id, merchant_key, category_id, kind, hits, source, updated_at FROM merchant_rules ORDER BY merchant_key, id'
  );
}

interface MetaAccountRow {
  account_key: string;
  account_label: string | null;
  account_last4: string | null;
  account_kind: string;
  institution: string | null;
  liability_id: string | null;
}

function knownAccounts(
  db: ClientDatabase,
  labels: Record<string, string>
): SmartImportContext['accounts'] {
  const rows = db.query<MetaAccountRow>(
    `SELECT account_key, account_label, account_last4, account_kind, institution, liability_id
       FROM smart_import_meta WHERE account_key IS NOT NULL
      ORDER BY ${newestFirst('created_at')}`
  );
  const seen = new Map<string, SmartImportContext['accounts'][number]>();
  for (const row of rows) {
    if (seen.has(row.account_key)) continue;
    seen.set(row.account_key, {
      account_key: row.account_key,
      label: labels[row.account_key] || row.account_label,
      last4: row.account_last4,
      kind: row.account_kind,
      institution: row.institution,
      liability_id: row.liability_id,
    });
  }
  return [...seen.values()].sort(
    (a, b) =>
      cmp((a.label ?? '').toLowerCase(), (b.label ?? '').toLowerCase()) ||
      cmp(a.account_key, b.account_key)
  );
}

/** GET /api/smart-import/context */
export function getSmartImportContext(db: ClientDatabase): SmartImportContext {
  return guarded('context', 'server_error', () => {
    const settings = readSettings(db);
    const cats = categories(db);
    const known = new Set(cats.map((c) => c.id));
    const rules = ruleRows(db)
      .filter((r) => r.category_id === null || known.has(r.category_id))
      .map((r) => ({
        id: r.id,
        merchant_key: r.merchant_key,
        category_id: r.category_id,
        kind: r.kind,
      }));
    return {
      rules,
      categories: cats.map((c) => ({ id: c.id, name: c.name })),
      accounts: knownAccounts(db, settings.accounts),
      csv_layouts: settings.csv_layouts,
      settings,
    };
  });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const HASH = /^[A-Za-z0-9_-]{1,100}$/;

function stringList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_PREVIEW_KEYS) throw fail('bad_request');
  for (const item of v) if (!textBetween(item, 0, 400)) throw fail('bad_request');
  return v as string[];
}

const STATEMENT_KEYS = [
  'file_hash',
  'account_key',
  'account_kind',
  'institution',
  'dedupe_keys',
  'merchant_keys',
];

function parsePreview(body: unknown): PreviewRequest {
  if (!isObj(body) || Object.keys(body).some((k) => k !== 'statements')) throw fail('bad_request');
  const raw = body.statements;
  if (!Array.isArray(raw) || raw.length > MAX_PREVIEW_STATEMENTS) throw fail('bad_request');
  const statements = raw.map((st) => {
    if (!isObj(st) || Object.keys(st).some((k) => !STATEMENT_KEYS.includes(k))) {
      throw fail('bad_request');
    }
    if (typeof st.file_hash !== 'string' || !HASH.test(st.file_hash)) throw fail('bad_request');
    if (
      typeof st.account_kind !== 'string' ||
      !(ACCOUNT_KINDS as readonly string[]).includes(st.account_kind)
    ) {
      throw fail('bad_request');
    }
    const optional = (v: unknown, max: number): string | null => {
      if (v === undefined || v === null) return null;
      if (!textBetween(v, 0, max)) throw fail('bad_request');
      return v;
    };
    return {
      file_hash: st.file_hash,
      account_key: optional(st.account_key, 200),
      account_kind: st.account_kind as PreviewRequest['statements'][number]['account_kind'],
      institution: optional(st.institution, 120),
      dedupe_keys: stringList(st.dedupe_keys),
      merchant_keys: stringList(st.merchant_keys),
    };
  });
  return { statements };
}

function existingDedupeKeys(db: ClientDatabase, keys: string[]): string[] {
  const found = new Set<string>();
  for (const chunk of chunks(keys)) {
    for (const row of db.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM import_transactions WHERE dedupe_key IN (${placeholders(chunk.length)})`,
      chunk
    )) {
      found.add(row.dedupe_key);
    }
  }
  return [...found].sort(cmp);
}

function priorFiles(db: ClientDatabase, hashes: string[]): PreviewResponse['prior_files'] {
  const prior: PreviewResponse['prior_files'] = [];
  for (const fileHash of hashes) {
    const row = db.query<{ id: string; analyzed_at: string | null; uploaded_at: string | null }>(
      `SELECT id, analyzed_at, uploaded_at FROM bank_statement_imports
        WHERE content_hash = ? OR substr(content_hash, 1, ?) = ?
        ORDER BY ${sortable('analyzed_at')} DESC, ${newestFirst('uploaded_at')} LIMIT 1`,
      [fileHash, fileHash.length + 1, `${fileHash}:`]
    )[0];
    if (row) {
      prior.push({
        file_hash: fileHash,
        import_id: row.id,
        imported_at: isoOut(row.analyzed_at || row.uploaded_at),
      });
    }
  }
  return prior;
}

interface LiabilityRow {
  id: string;
  name: string;
  liability_type: string;
  lender: string | null;
}

/** A card statement fits a card; a loan statement fits any other debt. */
const typeFits = (kind: string, liabilityType: string): boolean =>
  (liabilityType === 'credit_card') === (kind === 'credit_card');

function lenderMatch(
  institution: string | null | undefined,
  kind: string,
  liabilities: LiabilityRow[]
): string | null {
  const needle = (institution ?? '').trim().toLowerCase();
  if (!needle) return null;
  const fitting = liabilities.filter((x) => typeFits(kind, x.liability_type));
  const names = (x: LiabilityRow): string[] =>
    [x.lender, x.name]
      .filter((n): n is string => !!n && n.trim() !== '')
      .map((n) => n.trim().toLowerCase());
  for (const x of fitting) if (names(x).includes(needle)) return x.id;
  if (chars(needle) >= 3) {
    for (const x of fitting) {
      if (names(x).some((n) => chars(n) >= 3 && (n.includes(needle) || needle.includes(n)))) {
        return x.id;
      }
    }
  }
  return null;
}

function previousLiability(
  db: ClientDatabase,
  accountKey: string | null,
  activeIds: Set<string>
): string | null {
  if (!accountKey) return null;
  const rows = db.query<{ liability_id: string }>(
    `SELECT liability_id FROM smart_import_meta
      WHERE account_key = ? AND liability_id IS NOT NULL
      ORDER BY ${newestFirst('created_at')}`,
    [accountKey]
  );
  for (const row of rows) if (activeIds.has(row.liability_id)) return row.liability_id;
  return null;
}

const activeLiabilities = (db: ClientDatabase): LiabilityRow[] =>
  db.query<LiabilityRow>(
    'SELECT id, name, liability_type, lender FROM liabilities WHERE is_active = 1 ORDER BY name, id'
  );

/**
 * store.suggest_liability (plan B5): the debt a new connected card or loan
 * most likely belongs to, by the preview's rules (the debt an earlier import
 * of the same key was linked to, else a lender or name match). Null when
 * nothing fits. The caller keeps only a canonical id, as the server does.
 */
export function suggestLiability(
  db: ClientDatabase,
  institution: string | null,
  kind: string,
  accountKey: string | null
): string | null {
  const liabilities = activeLiabilities(db);
  const activeIds = new Set(liabilities.map((x) => x.id));
  return (
    previousLiability(db, accountKey, activeIds) ?? lenderMatch(institution, kind, liabilities)
  );
}

function liabilitySuggestions(
  db: ClientDatabase,
  statements: PreviewRequest['statements']
): PreviewResponse['liability_suggestions'] {
  const liabilities = activeLiabilities(db);
  const activeIds = new Set(liabilities.map((x) => x.id));
  const out: PreviewResponse['liability_suggestions'] = [];
  for (const st of statements) {
    if (!DEBT_KINDS.includes(st.account_kind)) continue;
    let liabilityId = previousLiability(db, st.account_key ?? null, activeIds);
    let reason: 'previous_import' | 'lender_match' = 'previous_import';
    if (liabilityId === null) {
      liabilityId = lenderMatch(st.institution, st.account_kind, liabilities);
      reason = 'lender_match';
    }
    if (liabilityId !== null) {
      out.push({
        file_hash: st.file_hash,
        account_key: st.account_key ?? null,
        liability_id: liabilityId,
        reason,
      });
    }
  }
  return out;
}

function history(db: ClientDatabase, keys: string[], since: string): PreviewResponse['history'] {
  const rows: { id: string; merchant_key: string; posted_date: string; amount: number }[] = [];
  for (const chunk of chunks(keys)) {
    rows.push(
      ...db.query<{ id: string; merchant_key: string; posted_date: string; amount: number }>(
        `SELECT id, merchant_key, posted_date, amount FROM import_transactions
          WHERE merchant_key IN (${placeholders(chunk.length)}) AND amount < 0 AND posted_date >= ?`,
        [...chunk, since]
      )
    );
  }
  rows.sort(
    (a, b) =>
      cmp(a.posted_date, b.posted_date) || cmp(a.merchant_key, b.merchant_key) || cmp(a.id, b.id)
  );
  return rows.map((r) => ({
    merchant_key: r.merchant_key,
    posted_date: r.posted_date,
    amount: r.amount,
  }));
}

/** POST /api/smart-import/preview (reads only; nothing is written) */
export function previewSmartImport(db: ClientDatabase, body: unknown): PreviewResponse {
  const request = parsePreview(body);
  return guarded('preview', 'server_error', () => {
    const since = minusDays(clockToday(), HISTORY_DAYS);
    const { statements } = request;
    const dedupeKeys = unique(statements.flatMap((st) => st.dedupe_keys));
    const merchantKeys = unique(
      statements.flatMap((st) => st.merchant_keys.map((k) => truncate(k, MAX_STORED_KEY_CHARS)))
    );
    const hashes = unique(statements.map((st) => st.file_hash));
    return {
      existing_dedupe_keys: existingDedupeKeys(db, dedupeKeys),
      prior_files: priorFiles(db, hashes),
      liability_suggestions: liabilitySuggestions(db, statements),
      history: history(db, merchantKeys, since),
    };
  });
}

// ---------------------------------------------------------------------------
// Imports and rules
// ---------------------------------------------------------------------------

/** GET /api/smart-import/imports: newest first; legacy imports (no meta row) are not listed. */
export function getSmartImports(db: ClientDatabase): SmartImportSummary[] {
  return guarded(
    'list_imports',
    'server_error',
    () =>
      db
        .query<Raw>(
          `SELECT m.import_id, m.batch_id, b.file_name, m.origin, m.format, m.parser, m.account_kind,
                m.account_key, m.account_label, m.account_last4, m.institution, m.period_start,
                m.period_end, m.closing_balance, m.closing_balance_date, m.liability_id,
                m.txn_new, m.txn_duplicate, m.txn_excluded, m.ai_used, m.ai_provider, m.connection_id,
                m.created_at
           FROM smart_import_meta m JOIN bank_statement_imports b ON b.id = m.import_id
          ORDER BY ${newestFirst('created_at', 'm.')}`
        )
        .map(({ created_at, ...rest }) => ({
          ...rest,
          imported_at: isoOut(created_at),
        })) as unknown as SmartImportSummary[]
  );
}

/** GET /api/smart-import/rules: every remembered merchant; a deleted category is flagged. */
export function getMerchantRules(db: ClientDatabase): MerchantRuleResponse[] {
  return guarded('list_rules', 'server_error', () => {
    const names = new Map(categories(db).map((c) => [c.id, c.name]));
    return ruleRows(db).map((r) => ({
      id: r.id,
      merchant_key: r.merchant_key,
      category_id: r.category_id,
      category_name: r.category_id ? (names.get(r.category_id) ?? null) : null,
      category_deleted: r.category_id !== null && !names.has(r.category_id),
      kind: r.kind,
      hits: r.hits,
      source: r.source,
      updated_at: isoOut(r.updated_at),
    }));
  });
}

/** DELETE /api/smart-import/rules/{id}: only the rule row is deleted. */
export function deleteMerchantRule(db: ClientDatabase, ruleId: string): SmartImportDeleted {
  return write(db, 'delete_rule', () => {
    if (!db.query('SELECT 1 FROM merchant_rules WHERE id = ?', [ruleId]).length) {
      throw fail('rule_not_found');
    }
    db.execute('DELETE FROM merchant_rules WHERE id = ?', [ruleId]);
    return { deleted: true };
  });
}

// ---------------------------------------------------------------------------
// Apply, undo, transactions delete, spending summary (mirror of service.py B3)
// ---------------------------------------------------------------------------

const SPEND_KINDS = ['expense', 'fee', 'interest', 'refund'];
const ANNUAL_MULTIPLIER: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  annual: 1,
  one_time: 0,
};
const TXN_KINDS = [
  'expense',
  'income',
  'transfer',
  'payment',
  'refund',
  'fee',
  'interest',
] as const;
const CATEGORY_SOURCES = ['user', 'rule', 'seed', 'ai', 'none'] as const;
const ORIGINS = ['file', 'sample', 'connector'] as const;
const FORMATS = ['csv', 'ofx', 'pdf', 'connector'] as const;
const RULE_SOURCES = ['user', 'import', 'ai', 'connector'] as const;
const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'] as const;
const MAX_APPLY_TRANSACTIONS = 10_000;
const MAX_APPLY_RULES = 5_000;
const MAX_APPLY_RECURRING = 500;
const MAX_MONEY = 1e10;
const EXPENSE_FIELDS = [
  'entity_id',
  'category_id',
  'name',
  'amount',
  'frequency',
  'is_pretax',
  'is_mortgage',
  'principal_portion',
  'interest_portion',
  'is_active',
  'start_date',
  'end_date',
  'updated_at',
];
const EXPENSE_BOOLS = ['is_pretax', 'is_mortgage', 'is_active'];
const nowIso = (): string => new Date().toISOString();
const uuid = (): string => crypto.randomUUID();

/** Apply wire types with every default filled in, as the parser returns them. */
type ParsedTxn = Required<ApplyTxn>;
type ParsedStatement = Omit<Required<ApplyStatement>, 'account' | 'period' | 'transactions'> & {
  account: Required<ApplyStatement['account']>;
  period: { start: string | null; end: string | null } | null;
  transactions: ParsedTxn[];
};
type ParsedRule = Required<ApplyRule>;
type ParsedRecurring = Required<ApplyRecurring>;
type ParsedApply = Omit<Required<ApplyRequest>, 'statements' | 'rules' | 'recurring'> & {
  statements: ParsedStatement[];
  rules: ParsedRule[];
  recurring: ParsedRecurring[];
};

/** A real calendar day written exactly 'YYYY-MM-DD' (never a datetime). */
function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const need = (ok: boolean): void => {
  if (!ok) throw fail('bad_request');
};

/** An object whose keys are all known (extra keys are rejected) and whose required keys are present. */
function shape(v: unknown, required: string[], optional: string[]): Raw {
  need(isObj(v));
  const o = v as Raw;
  for (const k of Object.keys(o)) need(required.includes(k) || optional.includes(k));
  for (const k of required) need(k in o);
  return o;
}

const present = (v: unknown): boolean => v !== undefined && v !== null;
const optText = (v: unknown, min: number, max: number): string | null => {
  if (!present(v)) return null;
  need(textBetween(v, min, max));
  return v as string;
};
const money = (v: unknown): number => {
  need(typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_MONEY);
  return v as number;
};
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => {
  need(typeof v === 'string' && (values as readonly string[]).includes(v));
  return v as T;
};

function parseTxn(raw: unknown): ParsedTxn {
  const o = shape(
    raw,
    [
      'posted_date',
      'amount',
      'description',
      'merchant_key',
      'kind',
      'category_source',
      'dedupe_key',
    ],
    ['category_id', 'ai_confidence', 'external_id', 'excluded']
  );
  need(isDay(o.posted_date));
  need(textBetween(o.description, 0, 2000));
  need(textBetween(o.merchant_key, 1, 400));
  need(textBetween(o.dedupe_key, 1, 400));
  let confidence: number | null = null;
  if (present(o.ai_confidence)) {
    need(typeof o.ai_confidence === 'number' && o.ai_confidence >= 0 && o.ai_confidence <= 1);
    confidence = o.ai_confidence as number;
  }
  if (o.excluded !== undefined) need(typeof o.excluded === 'boolean');
  return {
    posted_date: o.posted_date as string,
    amount: money(o.amount),
    description: o.description as string,
    merchant_key: o.merchant_key as string,
    kind: oneOf(o.kind, TXN_KINDS),
    category_id: optText(o.category_id, 0, 64),
    category_source: oneOf(o.category_source, CATEGORY_SOURCES),
    ai_confidence: confidence,
    external_id: optText(o.external_id, 0, 200),
    dedupe_key: o.dedupe_key as string,
    excluded: o.excluded === true,
  };
}

function parseStatement(raw: unknown): ParsedStatement {
  const o = shape(
    raw,
    ['file_hash', 'file_name', 'origin', 'format', 'parser', 'account', 'transactions'],
    ['period', 'closing_balance', 'liability_id', 'ai_used', 'ai_provider', 'connection_id']
  );
  need(typeof o.file_hash === 'string' && HASH.test(o.file_hash));
  need(textBetween(o.file_name, 0, 1000));
  need(textBetween(o.parser, 1, 64));
  const a = shape(o.account, ['kind', 'key'], ['label', 'last4', 'institution']);
  need(textBetween(a.key, 1, 200));
  let period: ParsedStatement['period'] = null;
  if (present(o.period)) {
    const p = shape(o.period, [], ['start', 'end']);
    for (const k of ['start', 'end']) need(!present(p[k]) || isDay(p[k]));
    period = {
      start: (p.start as string | null | undefined) ?? null,
      end: (p.end as string | null | undefined) ?? null,
    };
  }
  let closing: ParsedStatement['closing_balance'] = null;
  if (present(o.closing_balance)) {
    const c = shape(o.closing_balance, ['amount', 'as_of'], []);
    need(isDay(c.as_of));
    closing = { amount: money(c.amount), as_of: c.as_of as string };
  }
  if (o.ai_used !== undefined) need(typeof o.ai_used === 'boolean');
  need(Array.isArray(o.transactions) && o.transactions.length <= MAX_APPLY_TRANSACTIONS);
  const origin = oneOf(o.origin, ORIGINS);
  // A synced statement names its connection, and only a synced statement does.
  const connectionId = optText(o.connection_id, 1, 64);
  need((origin === 'connector') === (connectionId !== null));
  return {
    file_hash: o.file_hash as string,
    file_name: o.file_name as string,
    origin,
    format: oneOf(o.format, FORMATS),
    parser: o.parser as string,
    account: {
      kind: oneOf(a.kind, ACCOUNT_KINDS),
      key: a.key as string,
      label: optText(a.label, 0, 200),
      last4: optText(a.last4, 0, 32),
      institution: optText(a.institution, 0, 120),
    },
    period,
    closing_balance: closing,
    liability_id: optText(o.liability_id, 0, 64),
    ai_used: o.ai_used === true,
    ai_provider: optText(o.ai_provider, 0, 64),
    transactions: (o.transactions as unknown[]).map(parseTxn),
    connection_id: connectionId,
  };
}

function parseRule(raw: unknown): ParsedRule {
  const o = shape(raw, ['merchant_key'], ['category_id', 'kind', 'source']);
  need(textBetween(o.merchant_key, 1, 400));
  return {
    merchant_key: o.merchant_key as string,
    category_id: optText(o.category_id, 0, 64),
    kind: present(o.kind) ? oneOf(o.kind, TXN_KINDS) : null,
    source: o.source === undefined ? 'user' : oneOf(o.source, RULE_SOURCES),
  };
}

function parseRecurring(raw: unknown): ParsedRecurring {
  const o = shape(
    raw,
    [
      'merchant_key',
      'name',
      'amount',
      'frequency',
      'category_id',
      'occurrences',
      'file_hash',
      'decision',
    ],
    ['expense_id']
  );
  need(textBetween(o.merchant_key, 1, 400));
  need(textBetween(o.name, 1, 120));
  need(
    typeof o.amount === 'number' &&
      Number.isFinite(o.amount) &&
      o.amount > 0 &&
      o.amount <= MAX_MONEY
  );
  need(textBetween(o.category_id, 1, 64));
  need(
    typeof o.occurrences === 'number' &&
      Number.isInteger(o.occurrences) &&
      o.occurrences >= 1 &&
      o.occurrences <= 10_000
  );
  need(typeof o.file_hash === 'string' && HASH.test(o.file_hash));
  const decision = oneOf(o.decision, ['create', 'link', 'reject'] as const);
  const expenseId = present(o.expense_id) ? o.expense_id : null;
  if (expenseId !== null) need(textBetween(expenseId, 1, 64));
  need((decision === 'link') === (expenseId !== null));
  return {
    merchant_key: o.merchant_key as string,
    name: o.name as string,
    amount: o.amount as number,
    frequency: oneOf(o.frequency, FREQUENCIES),
    category_id: o.category_id as string,
    occurrences: o.occurrences as number,
    file_hash: o.file_hash as string,
    decision,
    expense_id: expenseId as string | null,
  };
}

function parseApply(body: unknown): ParsedApply {
  const o = shape(body, ['batch_id', 'statements'], ['entity_id', 'rules', 'recurring']);
  need(textBetween(o.batch_id, 1, 100));
  const entityId = present(o.entity_id) ? o.entity_id : null;
  if (entityId !== null) need(textBetween(entityId, 1, 64));
  need(Array.isArray(o.statements) && o.statements.length <= MAX_PREVIEW_STATEMENTS);
  const rules = o.rules === undefined ? [] : o.rules;
  const recurring = o.recurring === undefined ? [] : o.recurring;
  need(Array.isArray(rules) && rules.length <= MAX_APPLY_RULES);
  need(Array.isArray(recurring) && recurring.length <= MAX_APPLY_RECURRING);
  return {
    batch_id: o.batch_id as string,
    entity_id: entityId as string | null,
    statements: (o.statements as unknown[]).map(parseStatement),
    rules: (rules as unknown[]).map(parseRule),
    recurring: (recurring as unknown[]).map(parseRecurring),
  };
}

/** Add `delta` calendar months to a 'YYYY-MM-DD' day, clamping the day to the target month. */
function monthsAgo(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) - months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(Math.min(d, last), 2)}`;
}

function addLedger(
  db: ClientDatabase,
  importId: string,
  action: string,
  targetTable: string,
  targetId: string,
  before: Raw | null,
  after: Raw | null,
  now: string
): void {
  db.execute(
    `INSERT INTO smart_import_ledger (id, import_id, action, target_table, target_id, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(),
      importId,
      action,
      targetTable,
      targetId,
      before === null ? null : sortedJson(before),
      after === null ? null : sortedJson(after),
      now,
    ]
  );
}

/** Ledger order: created_at, then insertion order (rowid) so equal timestamps keep their sequence. */
const LEDGER_ORDER = `${sortable('created_at')}, rowid`;

function checkReferences(db: ClientDatabase, request: ParsedApply): void {
  const known = new Set(categories(db).map((c) => c.id));
  for (const rule of request.rules) {
    if (rule.category_id && !known.has(rule.category_id)) throw fail('category_not_found');
  }
  for (const rec of request.recurring) {
    if (rec.decision === 'create' && !known.has(rec.category_id)) throw fail('category_not_found');
    if (rec.decision === 'link') {
      const expense = db.query<{ entity_id: string | null; is_active: number }>(
        'SELECT entity_id, is_active FROM budget_expenses WHERE id = ?',
        [rec.expense_id]
      )[0];
      const household = expense !== undefined && expense.entity_id === null;
      if (
        !expense ||
        !expense.is_active ||
        !(household || expense.entity_id === request.entity_id)
      ) {
        throw fail('expense_not_found');
      }
    }
  }
  for (const st of request.statements) {
    if (
      st.liability_id &&
      !db.query('SELECT 1 FROM liabilities WHERE id = ?', [st.liability_id]).length
    ) {
      throw fail('liability_not_found');
    }
  }
  for (const st of request.statements) {
    if (st.connection_id !== null && !connectionExists(db, st.connection_id)) {
      throw fail('connection_not_found');
    }
  }
}

interface Created {
  import_id: string;
  file_hash: string;
  txn_new: number;
  txn_duplicate: number;
  txn_excluded: number;
  balance: string;
  statement: ParsedStatement;
}

function existingRows(db: ClientDatabase, keys: string[]): Map<string, [string, string]> {
  const found = new Map<string, [string, string]>();
  for (const chunk of chunks(keys)) {
    for (const r of db.query<{ dedupe_key: string; id: string; import_id: string }>(
      `SELECT dedupe_key, id, import_id FROM import_transactions WHERE dedupe_key IN (${placeholders(chunk.length)})`,
      chunk
    )) {
      found.set(r.dedupe_key, [r.id, r.import_id]);
    }
  }
  return found;
}

function insertStatement(
  db: ClientDatabase,
  st: ParsedStatement,
  contentHash: string,
  batch: { batch_id: string; entity_id: string | null },
  seen: Map<string, [string, string]>,
  now: string
): Created {
  const { account } = st;
  const period = st.period ?? { start: null, end: null };
  const closing = st.closing_balance;
  const importId = uuid();
  db.execute(
    `INSERT INTO bank_statement_imports (id, entity_id, file_name, content_hash, row_count, status, uploaded_at, analyzed_at)
     VALUES (?, ?, ?, ?, 0, 'applied', ?, ?)`,
    [importId, batch.entity_id, truncate(st.file_name, 255), contentHash, now, now]
  );
  const excluded = st.transactions.filter((t) => t.excluded).length;
  const candidates = st.transactions.filter((t) => !t.excluded);
  const existing = existingRows(db, unique(candidates.map((t) => t.dedupe_key)));
  let added = 0;
  let duplicate = 0;
  for (const t of candidates) {
    const owner = existing.get(t.dedupe_key) ?? seen.get(t.dedupe_key);
    if (owner) {
      duplicate += 1;
      if (owner[1] !== importId) {
        // The row stays with its owner; this import claims it so Undo of the owner hands it over.
        addLedger(
          db,
          importId,
          'claimed',
          'import_transactions',
          owner[0],
          null,
          { dedupe_key: t.dedupe_key },
          now
        );
      }
      continue;
    }
    const rowId = uuid();
    seen.set(t.dedupe_key, [rowId, importId]);
    added += 1;
    db.execute(
      `INSERT INTO import_transactions (id, import_id, entity_id, account_key, posted_date, amount, description,
         merchant_key, kind, category_id, category_source, ai_confidence, external_id, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rowId,
        importId,
        batch.entity_id,
        account.key,
        t.posted_date,
        t.amount,
        truncate(t.description, MAX_STORED_KEY_CHARS),
        truncate(t.merchant_key, MAX_STORED_KEY_CHARS),
        t.kind,
        t.category_id,
        t.category_source,
        t.ai_confidence,
        t.external_id,
        t.dedupe_key,
        now,
      ]
    );
  }
  db.execute('UPDATE bank_statement_imports SET row_count = ? WHERE id = ?', [added, importId]);
  db.execute(
    `INSERT INTO smart_import_meta (import_id, batch_id, origin, format, parser, account_kind, account_key,
       account_label, account_last4, institution, period_start, period_end, closing_balance, closing_balance_date,
       liability_id, txn_new, txn_duplicate, txn_excluded, ai_used, ai_provider, created_at, connection_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      importId,
      batch.batch_id,
      st.origin,
      st.format,
      st.parser,
      account.kind,
      account.key,
      account.label,
      account.last4 === null ? null : Array.from(account.last4).slice(-4).join(''),
      account.institution,
      period.start,
      period.end,
      closing ? closing.amount : null,
      closing ? closing.as_of : null,
      st.liability_id,
      added,
      duplicate,
      excluded,
      st.ai_used ? 1 : 0,
      st.ai_provider,
      now,
      st.connection_id,
    ]
  );
  return {
    import_id: importId,
    file_hash: st.file_hash,
    txn_new: added,
    txn_duplicate: duplicate,
    txn_excluded: excluded,
    balance: 'none',
    statement: st,
  };
}

function upsertRules(
  db: ClientDatabase,
  rules: ParsedRule[],
  importId: string,
  now: string
): number {
  const byKey = new Map<string, ParsedRule>();
  for (const rule of rules) byKey.set(truncate(rule.merchant_key, MAX_STORED_KEY_CHARS), rule); // the last choice wins
  for (const [key, rule] of byKey) {
    const row = db.query<{ id: string; hits: number | null }>(
      'SELECT id, hits FROM merchant_rules WHERE merchant_key = ?',
      [key]
    )[0];
    if (!row) {
      db.execute(
        `INSERT INTO merchant_rules (id, merchant_key, category_id, kind, hits, source, last_import_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [uuid(), key, rule.category_id, rule.kind, rule.source, importId, now, now]
      );
    } else {
      db.execute(
        `UPDATE merchant_rules SET category_id = ?, kind = ?, hits = ?, source = ?, last_import_id = ?, updated_at = ?
          WHERE id = ?`,
        [rule.category_id, rule.kind, (row.hits ?? 0) + 1, rule.source, importId, now, row.id]
      );
    }
  }
  return byKey.size;
}

/** Every user-editable expense column plus updated_at, as stored in the ledger. */
function expenseState(db: ClientDatabase, id: string): Raw | null {
  const row = db.query<Raw>('SELECT * FROM budget_expenses WHERE id = ?', [id])[0];
  if (!row) return null;
  const state: Raw = {};
  for (const field of EXPENSE_FIELDS) {
    const v = row[field] ?? null;
    if (field === 'updated_at') state[field] = isoOut(v);
    else state[field] = EXPENSE_BOOLS.includes(field) && v !== null ? Boolean(v) : v;
  }
  return state;
}

/** Any difference in a recorded field (updated_at included) means the user edited it. */
function expenseUnchanged(now: Raw, after: Raw): boolean {
  for (const [field, was] of Object.entries(after)) {
    if (!(field in now)) continue;
    const value = now[field];
    if (typeof value === 'number' || typeof was === 'number') {
      if (value === null || was === null || Math.abs(Number(value) - Number(was)) > 1e-9)
        return false;
    } else if (typeof value === 'boolean' || typeof was === 'boolean') {
      if (Boolean(value) !== Boolean(was)) return false;
    } else if (value !== was) {
      return false;
    }
  }
  return true;
}

function applyRecurring(
  db: ClientDatabase,
  recurring: ParsedRecurring[],
  imports: Created[],
  entityId: string | null,
  now: string
): [number, number] {
  const first = imports[0]!.import_id;
  const byHash = new Map<string, string>();
  for (const imp of imports)
    if (!byHash.has(imp.file_hash)) byHash.set(imp.file_hash, imp.import_id);
  let created = 0;
  let linked = 0;
  for (const rec of recurring) {
    const importId = byHash.get(rec.file_hash) ?? first;
    let expenseId: string | null = null;
    if (rec.decision === 'create') {
      expenseId = uuid();
      db.execute(
        `INSERT INTO budget_expenses (id, entity_id, category_id, name, amount, frequency, is_pretax, is_mortgage,
           is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
        [expenseId, entityId, rec.category_id, rec.name, rec.amount, rec.frequency, now, now]
      );
      addLedger(
        db,
        importId,
        'created',
        'budget_expenses',
        expenseId,
        null,
        expenseState(db, expenseId),
        now
      );
      created += 1;
    } else if (rec.decision === 'link') {
      expenseId = rec.expense_id;
      addLedger(db, importId, 'linked', 'budget_expenses', expenseId!, null, null, now);
      linked += 1;
    }
    db.execute(
      `INSERT INTO recurring_candidates (id, import_id, name, amount, frequency, occurrences, status, created_expense_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        importId,
        rec.name,
        rec.amount,
        rec.frequency,
        rec.occurrences,
        rec.decision === 'reject' ? 'rejected' : 'accepted',
        expenseId,
        now,
      ]
    );
  }
  return [created, linked];
}

/** Snapshot a statement's closing balance for its liability; never overwrites a same-day snapshot. */
function recordBalance(db: ClientDatabase, imp: Created, today: string, now: string): string {
  const { closing_balance: closing, liability_id: liabilityId } = imp.statement;
  if (!closing || !liabilityId || closing.amount < 0) return 'none'; // a credit balance never reaches a debt
  let day = closing.as_of;
  if (imp.statement.origin === 'connector' && day === minusDays(today, -1)) {
    // A provider dates balances by UTC, which can be a day ahead of the local
    // day: record it as today's. The meta row keeps the provider's date.
    day = today;
  }
  if (day > today) return 'skipped_future';
  if (
    db.query(
      'SELECT 1 FROM liability_balance_snapshots WHERE liability_id = ? AND snapshot_date = ?',
      [liabilityId, day]
    ).length
  ) {
    return 'skipped_existing';
  }
  const snapId = uuid();
  db.execute(
    `INSERT INTO liability_balance_snapshots (id, liability_id, snapshot_date, balance, source, source_ref, created_at)
     VALUES (?, ?, ?, ?, 'import', ?, ?)`,
    [snapId, liabilityId, day, closing.amount, imp.import_id, now]
  );
  addLedger(
    db,
    imp.import_id,
    'snapshot',
    'liability_balance_snapshots',
    snapId,
    null,
    { liability_id: liabilityId, snapshot_date: day, balance: closing.amount },
    now
  );
  const newest = db.query<{ d: string }>(
    'SELECT MAX(snapshot_date) AS d FROM liability_balance_snapshots WHERE liability_id = ?',
    [liabilityId]
  )[0]!.d;
  if (day === newest) {
    const row = db.query<Raw>(
      'SELECT current_balance, balance_as_of, updated_at FROM liabilities WHERE id = ?',
      [liabilityId]
    )[0]!;
    const before = {
      current_balance: row.current_balance,
      balance_as_of: row.balance_as_of,
      updated_at: isoOut(row.updated_at),
    };
    db.execute(
      'UPDATE liabilities SET current_balance = ?, balance_as_of = ?, updated_at = ? WHERE id = ?',
      [closing.amount, day, now, liabilityId]
    );
    addLedger(
      db,
      imp.import_id,
      'balance_moved',
      'liabilities',
      liabilityId,
      before,
      { current_balance: closing.amount, balance_as_of: day },
      now
    );
  }
  return 'recorded';
}

function prune(db: ClientDatabase, retentionMonths: number, today: string): number {
  if (retentionMonths <= 0) return 0;
  return db.execute(
    `DELETE FROM import_transactions WHERE posted_date < ?
       AND import_id NOT IN (SELECT import_id FROM smart_import_meta WHERE origin = 'sample')`,
    [monthsAgo(today, retentionMonths)]
  ).changes;
}

function applyInside(
  db: ClientDatabase,
  request: ParsedApply,
  today: string,
  now: string
): ApplyResponse {
  checkReferences(db, request);
  const batch = { batch_id: request.batch_id, entity_id: request.entity_id };
  const indexes = new Map<string, number>();
  const seen = new Map<string, [string, string]>();
  const skipped: string[] = [];
  const imports: Created[] = [];
  for (const st of request.statements) {
    const index = indexes.get(st.file_hash) ?? 0;
    indexes.set(st.file_hash, index + 1);
    const contentHash = index === 0 ? st.file_hash : `${st.file_hash}:${index}`;
    if (
      db.query('SELECT 1 FROM bank_statement_imports WHERE content_hash = ?', [contentHash]).length
    ) {
      if (!skipped.includes(st.file_hash)) skipped.push(st.file_hash);
      continue;
    }
    imports.push(insertStatement(db, st, contentHash, batch, seen, now));
  }
  let rulesSaved = 0;
  let created = 0;
  let linked = 0;
  let pruned = 0;
  // Rules, recurring, balances and the prune only run when the batch created an import.
  if (imports.length) {
    if (request.rules.length)
      rulesSaved = upsertRules(db, request.rules, imports[0]!.import_id, now);
    [created, linked] = applyRecurring(db, request.recurring, imports, batch.entity_id, now);
    for (const imp of imports) imp.balance = recordBalance(db, imp, today, now);
    pruned = prune(db, readSettings(db).retention_months, today);
  }
  const appliedHashes = new Set(imports.map((i) => i.file_hash));
  return {
    imports: imports.map(({ statement: _s, ...rest }) => rest) as ApplyResponse['imports'],
    skipped_files: skipped.filter((h) => !appliedHashes.has(h)),
    rules_saved: rulesSaved,
    expenses_created: created,
    expenses_linked: linked,
    pruned,
  };
}

/** POST /api/smart-import/apply: one atomic apply, ledgering everything it changes. */
export function applySmartImport(db: ClientDatabase, body: unknown): ApplyResponse {
  const request = parseApply(body);
  const today = clockToday();
  const now = nowIso();
  const result = write(db, 'apply', () => applyInside(db, request, today, now));
  console.info(
    `smart_import_applied imports=${result.imports.length} skipped=${result.skipped_files.length}`
  );
  return result;
}

// ------------------------------------------------------------------- undo

function restoreLiabilityBalance(
  db: ClientDatabase,
  liabilityId: string,
  before: Raw,
  now: string
): void {
  const row = db.query<{ current_balance: number; balance_as_of: string }>(
    'SELECT current_balance, balance_as_of FROM liabilities WHERE id = ?',
    [liabilityId]
  )[0];
  if (!row) return;
  const newest = db.query<{ balance: number; snapshot_date: string }>(
    'SELECT balance, snapshot_date FROM liability_balance_snapshots WHERE liability_id = ? ORDER BY snapshot_date DESC LIMIT 1',
    [liabilityId]
  )[0];
  const balance = newest ? newest.balance : (before.current_balance as number);
  const day = newest ? newest.snapshot_date : (before.balance_as_of as string);
  if (row.current_balance !== balance || row.balance_as_of !== day) {
    db.execute(
      'UPDATE liabilities SET current_balance = ?, balance_as_of = ?, updated_at = ? WHERE id = ?',
      [balance, day, now, liabilityId]
    );
  }
}

/** Rows this import owns that a later import claimed move to the newest claimer instead of being deleted. */
function handOverClaimedRows(db: ClientDatabase, importId: string): number {
  const owned = db
    .query<{ id: string }>('SELECT id FROM import_transactions WHERE import_id = ?', [importId])
    .map((r) => r.id);
  const claims = new Map<string, string>(); // row id -> newest surviving claimer
  for (const chunk of chunks(owned)) {
    const rows = db.query<{ target_id: string; import_id: string }>(
      `SELECT target_id, import_id FROM smart_import_ledger
        WHERE action = 'claimed' AND import_id != ? AND target_id IN (${placeholders(chunk.length)})
        ORDER BY ${LEDGER_ORDER}`,
      [importId, ...chunk]
    );
    for (const row of rows) claims.set(row.target_id, row.import_id); // ascending, so the newest wins
  }
  const byClaimer = new Map<string, string[]>();
  for (const [rowId, claimer] of claims)
    byClaimer.set(claimer, [...(byClaimer.get(claimer) ?? []), rowId]);
  for (const [claimer, ids] of byClaimer) {
    for (const chunk of chunks(ids)) {
      const marks = placeholders(chunk.length);
      db.execute(`UPDATE import_transactions SET import_id = ? WHERE id IN (${marks})`, [
        claimer,
        ...chunk,
      ]);
      db.execute(
        `DELETE FROM smart_import_ledger WHERE action = 'claimed' AND import_id = ? AND target_id IN (${marks})`,
        [claimer, ...chunk]
      );
    }
    db.execute(
      'UPDATE smart_import_meta SET txn_new = txn_new + ?, txn_duplicate = max(0, txn_duplicate - ?) WHERE import_id = ?',
      [ids.length, ids.length, claimer]
    );
    db.execute(
      'UPDATE bank_statement_imports SET row_count = coalesce(row_count, 0) + ? WHERE id = ?',
      [ids.length, claimer]
    );
  }
  return claims.size;
}

/**
 * Undo one import inside the caller's transaction (twin of the server's
 * `undo_in_session`): it opens no savepoint and commits nothing, so a caller
 * such as disconnect with remove_data (local-connections.ts) can undo several
 * imports and roll all of them back together. `now` is an ISO timestamp.
 */
export function undoInside(
  db: ClientDatabase,
  importId: string,
  now: string
): SmartImportUndoResponse {
  if (!db.query('SELECT 1 FROM smart_import_meta WHERE import_id = ?', [importId]).length) {
    // A plain statement import row is a legacy import; no row at all is unknown or already undone.
    throw fail(
      db.query('SELECT 1 FROM bank_statement_imports WHERE id = ?', [importId]).length
        ? 'not_smart_import'
        : 'import_not_found'
    );
  }
  const ledger = db.query<{
    action: string;
    target_table: string;
    target_id: string;
    before_json: string | null;
    after_json: string | null;
  }>(
    `SELECT action, target_table, target_id, before_json, after_json FROM smart_import_ledger
      WHERE import_id = ? ORDER BY ${LEDGER_ORDER}`,
    [importId]
  );
  const kept: SmartImportUndoResponse['kept'] = [];
  const deleted = { transactions: 0, recurring_candidates: 0, expenses: 0, snapshots: 0 };
  const reassigned = handOverClaimedRows(db, importId);
  deleted.transactions = db.execute('DELETE FROM import_transactions WHERE import_id = ?', [
    importId,
  ]).changes;
  // Candidates go before any expense: created_expense_id references budget_expenses.
  deleted.recurring_candidates = db.execute(
    'DELETE FROM recurring_candidates WHERE import_id = ?',
    [importId]
  ).changes;
  for (const row of ledger) {
    if (row.action !== 'created' || row.target_table !== 'budget_expenses') continue;
    const state = expenseState(db, row.target_id);
    if (state === null) continue;
    let reason: string | null = null;
    if (!expenseUnchanged(state, JSON.parse(row.after_json ?? '{}') as Raw)) reason = 'edited';
    else if (db.query('SELECT 1 FROM liabilities WHERE expense_id = ?', [row.target_id]).length)
      reason = 'linked_to_debt';
    else if (
      db.query(
        'SELECT 1 FROM recurring_candidates WHERE created_expense_id = ? AND import_id != ?',
        [row.target_id, importId]
      ).length
    ) {
      reason = 'used_by_other_import';
    }
    if (reason) {
      kept.push({ table: 'budget_expenses', id: row.target_id, reason });
    } else {
      db.execute('DELETE FROM budget_expenses WHERE id = ?', [row.target_id]);
      deleted.expenses += 1;
    }
  }
  for (const row of ledger) {
    if (row.action !== 'snapshot') continue;
    const snap = db.query<{
      source: string;
      source_ref: string | null;
      balance: number;
      snapshot_date: string;
    }>(
      'SELECT source, source_ref, balance, snapshot_date FROM liability_balance_snapshots WHERE id = ?',
      [row.target_id]
    )[0];
    if (!snap) continue;
    const after = JSON.parse(row.after_json ?? '{}') as Raw;
    const untouched =
      snap.source === 'import' &&
      snap.source_ref === importId &&
      Math.abs(snap.balance - Number(after.balance ?? 0)) < 1e-9 &&
      snap.snapshot_date === after.snapshot_date;
    if (untouched) {
      db.execute('DELETE FROM liability_balance_snapshots WHERE id = ?', [row.target_id]);
      deleted.snapshots += 1;
    } else {
      kept.push({ table: 'liability_balance_snapshots', id: row.target_id, reason: 'edited' });
    }
  }
  for (const row of ledger) {
    if (row.action === 'balance_moved') {
      restoreLiabilityBalance(db, row.target_id, JSON.parse(row.before_json ?? '{}') as Raw, now);
    }
  }
  db.execute('DELETE FROM smart_import_ledger WHERE import_id = ?', [importId]);
  db.execute('DELETE FROM smart_import_meta WHERE import_id = ?', [importId]);
  db.execute('DELETE FROM bank_statement_imports WHERE id = ?', [importId]);
  return { undone: true, deleted, reassigned: { transactions: reassigned }, kept };
}

/**
 * The imports synced from one connection, newest first: created_at, then
 * insertion order (twin of the server's `connection_import_ids`). Statements
 * of one Apply share created_at, so the later one comes first.
 */
export function connectionImportIds(db: ClientDatabase, connectionId: string): string[] {
  return db
    .query<{ import_id: string }>(
      `SELECT import_id FROM smart_import_meta WHERE connection_id = ?
        ORDER BY ${newestFirst('created_at')}`,
      [connectionId]
    )
    .map((row) => row.import_id);
}

/** DELETE /api/smart-import/imports/{id}: remove exactly what one import created, keep what the user changed. */
export function undoSmartImport(db: ClientDatabase, importId: string): SmartImportUndoResponse {
  const now = nowIso();
  const result = write(db, 'undo', () => undoInside(db, importId, now));
  console.info(`smart_import_undone id=${importId}`);
  return result;
}

/** DELETE /api/smart-import/transactions: transaction detail only; everything else stays. */
export function deleteSmartImportTransactions(db: ClientDatabase): SmartImportTransactionsDeleted {
  const result = write(db, 'delete_transactions', () => ({
    deleted: db.execute('DELETE FROM import_transactions').changes,
  }));
  console.info(`smart_import_transactions_deleted count=${result.deleted}`);
  return result;
}

// --------------------------------------------------------- spending summary

function monthKeys(start: string, end: string): Set<string> {
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const endYear = Number(end.slice(0, 4));
  const endMonth = Number(end.slice(5, 7));
  const out = new Set<string>();
  for (let i = 0; i < 1200; i++) {
    if (year > endYear || (year === endYear && month > endMonth)) break;
    out.add(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`);
    if (month < 12) month += 1;
    else {
      year += 1;
      month = 1;
    }
  }
  return out;
}

/** Months an import still has a stored transaction in; with a period, only months inside it count. */
function coveredMonths(db: ClientDatabase, entityId: string | null): Set<string> {
  const rows = db.query<{
    import_id: string;
    period_start: string | null;
    period_end: string | null;
  }>(
    `SELECT m.import_id, m.period_start, m.period_end FROM smart_import_meta m
       JOIN bank_statement_imports b ON b.id = m.import_id${entityId ? ' WHERE b.entity_id = ?' : ''}`,
    entityId ? [entityId] : []
  );
  const periods = new Map<string, Set<string> | null>();
  for (const r of rows) {
    periods.set(
      r.import_id,
      r.period_start && r.period_end ? monthKeys(r.period_start, r.period_end) : null
    );
  }
  const covered = new Set<string>();
  for (const chunk of chunks([...periods.keys()])) {
    for (const r of db.query<{ import_id: string; posted_date: string }>(
      `SELECT DISTINCT import_id, posted_date FROM import_transactions WHERE import_id IN (${placeholders(chunk.length)})`,
      chunk
    )) {
      const month = r.posted_date.slice(0, 7);
      const allowed = periods.get(r.import_id);
      if (allowed === null || allowed?.has(month)) covered.add(month);
    }
  }
  return covered;
}

/** Python-style round(x, 2): exact ties go to the even neighbor, everything else to the nearest. */
function round2(x: number): number {
  const a = Math.abs(x);
  const scaled = a * 100;
  const floor = Math.floor(scaled);
  const tie = scaled - floor === 0.5 && (floor + 0.5) / 100 === a;
  const value = tie ? (floor % 2 === 0 ? floor : floor + 1) / 100 : Number(a.toFixed(2));
  return x < 0 && value !== 0 ? -value : value;
}

function parseMonths(v: unknown): number {
  if (v === undefined || v === null) return 3;
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) n = Number(v);
  else throw fail('bad_request');
  need(Number.isInteger(n) && n >= 1 && n <= 24);
  return n;
}

/** GET /api/budget/spending-summary: planned versus actual monthly spending by category. */
export function getSpendingSummary(
  db: ClientDatabase,
  monthsParam?: unknown,
  entityParam?: unknown
): SpendingSummary {
  const months = parseMonths(monthsParam);
  if (present(entityParam)) need(typeof entityParam === 'string' && chars(entityParam) <= 64);
  const entityId = typeof entityParam === 'string' && entityParam !== '' ? entityParam : null;
  return guarded('spending_summary', 'server_error', () => {
    const today = clockToday();
    const current = today.slice(0, 7);
    const covered = [...coveredMonths(db, entityId)]
      .filter((m) => m < current)
      .sort(cmp)
      .reverse();
    const selected = covered.slice(0, months).sort(cmp);
    const names = new Map(categories(db).map((c) => [c.id, c.name]));
    const actual = new Map<string | null, number>();
    if (selected.length) {
      const chosen = new Set(selected);
      const rows = db.query<{ category_id: string | null; amount: number; posted_date: string }>(
        `SELECT category_id, amount, posted_date FROM import_transactions
          WHERE kind IN (${placeholders(SPEND_KINDS.length)}) AND posted_date >= ?${entityId ? ' AND entity_id = ?' : ''}`,
        [...SPEND_KINDS, `${selected[0]}-01`, ...(entityId ? [entityId] : [])]
      );
      for (const r of rows) {
        if (!chosen.has(r.posted_date.slice(0, 7))) continue;
        const key = r.category_id !== null && names.has(r.category_id) ? r.category_id : null; // a deleted category is uncategorized
        actual.set(key, (actual.get(key) ?? 0) - Number(r.amount));
      }
    }
    const planned = new Map<string | null, number>();
    const expenses = db.query<{
      category_id: string | null;
      amount: number;
      frequency: string | null;
    }>(
      `SELECT category_id, amount, frequency FROM budget_expenses WHERE is_active = 1${entityId ? ' AND entity_id = ?' : ''}`,
      entityId ? [entityId] : []
    );
    for (const e of expenses) {
      const key = e.category_id !== null && names.has(e.category_id) ? e.category_id : null;
      const yearly = Number(e.amount) * (ANNUAL_MULTIPLIER[e.frequency ?? ''] ?? 12);
      planned.set(key, (planned.get(key) ?? 0) + yearly / 12);
    }
    const divisor = selected.length || 1;
    const lines: SpendingSummary['categories'] = [];
    for (const key of new Set<string | null>([...actual.keys(), ...planned.keys()])) {
      const a = round2((actual.get(key) ?? 0) / divisor);
      const p = round2(planned.get(key) ?? 0);
      if (key === null && a === 0 && p === 0) continue;
      lines.push({
        category_id: key,
        category_name: key === null ? 'Uncategorized' : (names.get(key) as string),
        actual_monthly: a,
        planned_monthly: p,
        difference: round2(a - p),
      });
    }
    lines.sort((x, y) => {
      if ((x.category_id === null) !== (y.category_id === null))
        return x.category_id === null ? 1 : -1;
      return (
        cmp(x.category_name.toLowerCase(), y.category_name.toLowerCase()) ||
        cmp(x.category_id ?? '', y.category_id ?? '')
      );
    });
    const totalA = round2(lines.reduce((sum, l) => sum + l.actual_monthly, 0));
    const totalP = round2(lines.reduce((sum, l) => sum + l.planned_monthly, 0));
    return {
      months_covered: selected.length,
      months: selected,
      categories: lines,
      totals: {
        actual_monthly: totalA,
        planned_monthly: totalP,
        difference: round2(totalA - totalP),
      },
    };
  });
}
