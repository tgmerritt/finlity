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
import { today as clockToday } from '@/utils/clock';
import type {
  MerchantRuleResponse,
  PreviewRequest,
  PreviewResponse,
  SmartImportContext,
  SmartImportDeleted,
  SmartImportSettings,
  SmartImportSettingsUpdate,
  SmartImportSummary,
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
const ACCOUNT_KINDS = ['checking', 'savings', 'credit_card', 'loan', 'unknown'];
const MAX_PREVIEW_STATEMENTS = 12;
const MAX_PREVIEW_KEYS = 10_000;

// ---------------------------------------------------------------------------
// Errors: the fixed catalog entries these routes use (src/smart_import/errors.py)
// ---------------------------------------------------------------------------

const CATALOG: Record<string, [number, string]> = {
  bad_request: [422, 'The request could not be read.'],
  rule_not_found: [404, 'Rule not found.'],
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
      ORDER BY ${sortable('created_at')} DESC, import_id DESC`
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
    if (typeof st.account_kind !== 'string' || !ACCOUNT_KINDS.includes(st.account_kind)) {
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
        ORDER BY ${sortable('analyzed_at')} DESC, ${sortable('uploaded_at')} DESC, id DESC LIMIT 1`,
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
      ORDER BY ${sortable('created_at')} DESC, import_id DESC`,
    [accountKey]
  );
  for (const row of rows) if (activeIds.has(row.liability_id)) return row.liability_id;
  return null;
}

function liabilitySuggestions(
  db: ClientDatabase,
  statements: PreviewRequest['statements']
): PreviewResponse['liability_suggestions'] {
  const liabilities = db.query<LiabilityRow>(
    'SELECT id, name, liability_type, lender FROM liabilities WHERE is_active = 1 ORDER BY name, id'
  );
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
                m.txn_new, m.txn_duplicate, m.txn_excluded, m.ai_used, m.ai_provider, m.created_at
           FROM smart_import_meta m JOIN bank_statement_imports b ON b.id = m.import_id
          ORDER BY ${sortable('m.created_at')} DESC, m.import_id DESC`
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
