/**
 * Pure wizard state for smart import (design section 13). No DOM, no I/O: every
 * function takes a WizardState and returns a new one (or a request body), so the
 * wizard shell can render from it and tests can drive it directly.
 *
 * Privacy: buildCategorizeRequest is the only place the AI payload is built, and
 * the "What gets sent" panel renders its output, so the two cannot drift.
 */

import type {
  AnalyzeResponse,
  ApplyRecurring,
  ApplyRequest,
  ApplyRule,
  ApplyStatement,
  ApplyTxn,
  CategorizeItem,
  CategorizeRequest,
  CategorizeResponse,
  NormalizedStatement,
  PreviewRequest,
  PreviewResponse,
  RecurringCandidateSuggestion,
  SmartImportAccountKind,
  SmartImportContext,
  SmartImportTxnKind,
} from '@/types/api';

/** Server limits (src/smart_import/ai_categorize.py); the request is strict. */
const AI_MAX_ITEMS = 60;
const AI_MAX_CATEGORIES = 60;
const AI_MAX_CATEGORY_CHARS = 60;
const AI_MAX_MERCHANT_CHARS = 48;
const AI_MIN_LETTERS = 3;
/** Below this confidence an AI suggestion is pre-filled but still needs review. */
export const AI_CONFIDENT = 0.8;

/** Kinds that carry a category and count as spending (design 6.1). */
const SPENDING_KINDS: ReadonlySet<SmartImportTxnKind> = new Set([
  'expense',
  'fee',
  'interest',
  'refund',
]);
/** Rows of these kinds are never sent to the AI (they carry personal names). */
const AI_SKIP_KINDS: ReadonlySet<SmartImportTxnKind> = new Set(['transfer', 'income', 'payment']);

export type RowSource = 'rule' | 'seed' | 'ai' | 'user' | 'none';
export type RowFilter = 'review' | 'all' | 'duplicates' | 'excluded';

/** Per-file overrides sent as the analyze `context` (besides rules and categories). */
export interface AnalyzeOverrides {
  origin?: 'file' | 'sample';
  mapping?: Record<string, string>;
  account_kind?: SmartImportAccountKind;
  flip_sign?: boolean;
  date_order?: string;
}

export interface WizardFile {
  id: string;
  file_name: string;
  origin: 'file' | 'sample';
  status: 'pending' | 'ok' | 'needs_mapping' | 'needs_ai_layout' | 'error';
  /** Catalog code of a failed analyze (never message text). */
  error_type: string | null;
  headers: string[];
  sample_rows: string[][];
  lines: string[];
  line_count: number;
  /** From a needs_ai_layout answer; kept when the AI extract result replaces it. */
  file_hash: string | null;
  options: AnalyzeOverrides;
}

export interface WizardStatement {
  /** `${fileId}:${index}` */
  id: string;
  file_id: string;
  file_hash: string;
  file_name: string;
  origin: NormalizedStatement['origin'];
  format: NormalizedStatement['format'];
  parser: string;
  /** Starts as the parsed kind; the Accounts step may change it. */
  account_kind: SmartImportAccountKind;
  /** The parsed `acct:...` key, or null until the user labels the account. */
  account_key: string | null;
  account_label: string | null;
  last4: string | null;
  institution: string | null;
  period: NormalizedStatement['period'];
  closing_balance: NormalizedStatement['closing_balance'];
  extras: NormalizedStatement['extras'];
  warnings: string[];
  /** The user's debt choice. Suggestions never set it. */
  liability_id: string | null;
  suggested_liability_id: string | null;
  skipped: boolean;
  /** Set by applyPreview when this file hash was imported before. */
  prior_import_at: string | null;
}

export interface WizardRow {
  /** `${statementId}:${row}` */
  id: string;
  statement_id: string;
  posted_date: string;
  amount: number;
  description: string;
  merchant_key: string;
  kind: SmartImportTxnKind;
  category_id: string | null;
  category_source: RowSource;
  ai_confidence: number | null;
  external_id: string | null;
  dedupe_base: string;
  duplicate: boolean;
  excluded: boolean;
  /** The user accepted an AI suggestion, so it no longer needs review. */
  reviewed: boolean;
}

export interface RecurringChoice extends RecurringCandidateSuggestion {
  /** Ticked: create the expense (or link the matched one). Unticked: reject. */
  checked: boolean;
}

export interface RememberedChoice {
  category_id?: string | null;
  kind?: SmartImportTxnKind;
}

export interface WizardState {
  batch_id: string;
  entity_id: string | null;
  categories: { id: string; name: string }[];
  files: WizardFile[];
  statements: WizardStatement[];
  rows: WizardRow[];
  /** merchant_key -> choice to remember (becomes a rule at Apply). */
  remembered: Record<string, RememberedChoice>;
  /** Recurring-detection history from the preview. */
  history: PreviewResponse['history'];
  recurring: RecurringChoice[];
  ai_provider: string | null;
}

export interface RecurringReference {
  expenses: {
    id: string;
    name: string;
    amount: number;
    frequency: string;
    category_id: string | null;
    is_active?: boolean;
  }[];
  categories: { id: string; name: string }[];
}

export interface RecurringRequest {
  rows: {
    merchant_key: string;
    kind: SmartImportTxnKind;
    amount: number;
    posted_date: string;
    description: string;
    category_id: string | null;
  }[];
  history: PreviewResponse['history'];
  expenses: RecurringReference['expenses'];
  categories: RecurringReference['categories'];
}

export interface ReviewCounts {
  new: number;
  duplicates: number;
  excluded: number;
  needs_review: number;
  merchants_to_remember: number;
  files_skipped: number;
  expenses_to_add: number;
  expenses_to_link: number;
  /** Linked debts with the statement's closing balance; the UI adds "before". */
  debts: {
    liability_id: string;
    statement_id: string;
    label: string;
    closing_balance: number;
    as_of: string;
  }[];
}

export function createWizardState(
  ctx: Pick<SmartImportContext, 'categories'>,
  batchId: string,
  entityId: string | null = null
): WizardState {
  return {
    batch_id: batchId,
    entity_id: entityId,
    categories: ctx.categories,
    files: [],
    statements: [],
    rows: [],
    remembered: {},
    history: [],
    recurring: [],
    ai_provider: null,
  };
}

// ---------------------------------------------------------------- helpers

const isSpending = (kind: SmartImportTxnKind): boolean => SPENDING_KINDS.has(kind);

/** The key dedupe and apply use: the parsed key, else the user's label. */
export function accountKey(
  stmt: Pick<WizardStatement, 'account_key' | 'account_label'>
): string | null {
  if (stmt.account_key) return stmt.account_key;
  const label = stmt.account_label?.trim().toLowerCase();
  return label ? `label:${label}` : null;
}

const isActive = (stmt: WizardStatement): boolean => !stmt.skipped;
/** Skipped by the user, or a file already imported (Apply would skip it too). */
const isLeftOut = (stmt: WizardStatement): boolean => stmt.skipped || stmt.prior_import_at !== null;

function activeRows(state: WizardState): WizardRow[] {
  const active = new Set(state.statements.filter(isActive).map((s) => s.id));
  return state.rows.filter((r) => active.has(r.statement_id));
}

export function needsReview(row: WizardRow): boolean {
  if (row.excluded || row.duplicate || !isSpending(row.kind)) return false;
  if (row.category_id === null) return true;
  return row.category_source === 'ai' && !row.reviewed && (row.ai_confidence ?? 0) < AI_CONFIDENT;
}

function mapRows(state: WizardState, fn: (row: WizardRow) => WizardRow): WizardState {
  return { ...state, rows: state.rows.map(fn) };
}

function mapFile(
  state: WizardState,
  fileId: string,
  fn: (f: WizardFile) => WizardFile
): WizardState {
  return { ...state, files: state.files.map((f) => (f.id === fileId ? fn(f) : f)) };
}

function newFile(id: string, fileName: string, origin: 'file' | 'sample'): WizardFile {
  return {
    id,
    file_name: fileName,
    origin,
    status: 'pending',
    error_type: null,
    headers: [],
    sample_rows: [],
    lines: [],
    line_count: 0,
    file_hash: null,
    options: {},
  };
}

// ---------------------------------------------------------------- files and analyze

export function addFile(
  state: WizardState,
  file: { id: string; file_name: string; origin?: 'file' | 'sample' }
): WizardState {
  if (state.files.some((f) => f.id === file.id)) return state;
  return {
    ...state,
    files: [...state.files, newFile(file.id, file.file_name, file.origin ?? 'file')],
  };
}

export function setFileOptions(
  state: WizardState,
  fileId: string,
  patch: AnalyzeOverrides
): WizardState {
  return mapFile(state, fileId, (f) => ({ ...f, options: { ...f.options, ...patch } }));
}

export function markFileError(state: WizardState, fileId: string, errorType: string): WizardState {
  return mapFile(state, fileId, (f) => ({ ...f, status: 'error', error_type: errorType }));
}

/** The analyze `context`: remembered rules, categories and the file's overrides. */
export function buildAnalyzeContext(
  ctx: Pick<SmartImportContext, 'rules' | 'categories'>,
  overrides: AnalyzeOverrides
): Record<string, unknown> {
  const out: Record<string, unknown> = { rules: ctx.rules, categories: ctx.categories };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Fold one analyze (or AI extract) answer into the state, replacing the file's earlier rows. */
export function mergeAnalyze(
  state: WizardState,
  fileId: string,
  response: AnalyzeResponse
): WizardState {
  const first = response.status === 'ok' ? response.statements[0] : undefined;
  const base = state.files.some((f) => f.id === fileId)
    ? state
    : addFile(state, { id: fileId, file_name: first?.file_name ?? '' });
  const previous = new Map(
    base.statements.filter((s) => s.file_id === fileId).map((s) => [s.id, s])
  );
  const statements = base.statements.filter((s) => s.file_id !== fileId);
  const rows = base.rows.filter((r) => !r.statement_id.startsWith(`${fileId}:`));
  const reset = { error_type: null, headers: [], sample_rows: [], lines: [], line_count: 0 };

  if (response.status === 'needs_mapping') {
    const next = mapFile(base, fileId, (f) => ({
      ...f,
      ...reset,
      status: 'needs_mapping',
      headers: response.headers,
      sample_rows: response.sample_rows,
    }));
    return { ...next, statements, rows };
  }
  if (response.status === 'needs_ai_layout') {
    const next = mapFile(base, fileId, (f) => ({
      ...f,
      ...reset,
      status: 'needs_ai_layout',
      file_hash: response.file_hash,
      line_count: response.line_count,
      lines: response.lines,
    }));
    return { ...next, statements, rows };
  }

  const file = base.files.find((f) => f.id === fileId)!;
  const newStatements: WizardStatement[] = [];
  const newRows: WizardRow[] = [];
  response.statements.forEach((s, index) => {
    const id = `${fileId}:${index}`;
    const old = previous.get(id);
    newStatements.push({
      id,
      file_id: fileId,
      // An AI extract result keeps the hash of the file the layout answer named.
      file_hash: file.file_hash ?? s.file_hash,
      file_name: s.file_name,
      origin: s.origin,
      format: s.format,
      parser: s.parser,
      account_kind: s.account.kind,
      account_key: s.account.key,
      account_label: old?.account_label ?? null,
      last4: s.account.last4,
      institution: s.account.institution,
      period: s.period,
      closing_balance: s.closing_balance,
      extras: s.extras,
      warnings: s.warnings,
      liability_id: old?.liability_id ?? null,
      suggested_liability_id: null,
      skipped: old?.skipped ?? false,
      prior_import_at: null,
    });
    for (const t of s.transactions) {
      newRows.push({
        id: `${id}:${t.row}`,
        statement_id: id,
        posted_date: t.posted_date,
        amount: t.amount,
        description: t.description,
        merchant_key: t.merchant_key,
        kind: t.kind,
        category_id: t.category_id,
        category_source: t.category_id === null ? 'none' : t.category_source,
        ai_confidence: null,
        external_id: t.external_id,
        dedupe_base: t.dedupe_base,
        duplicate: false,
        excluded: false,
        reviewed: false,
      });
    }
  });
  const next = mapFile(base, fileId, (f) => ({ ...f, ...reset, status: 'ok' }));
  return { ...next, statements: [...statements, ...newStatements], rows: [...rows, ...newRows] };
}

export type StatementPatch = Partial<
  Pick<WizardStatement, 'account_kind' | 'account_label' | 'liability_id' | 'skipped'>
>;

export function setStatement(
  state: WizardState,
  statementId: string,
  patch: StatementPatch
): WizardState {
  return {
    ...state,
    statements: state.statements.map((s) => (s.id === statementId ? { ...s, ...patch } : s)),
  };
}

// ---------------------------------------------------------------- preview

const dedupeKey = (key: string, row: WizardRow): string => `${key}|${row.dedupe_base}`;

/** Statements without an account key or label are left out until the user labels them. */
export function buildPreviewRequest(state: WizardState): PreviewRequest {
  const statements: PreviewRequest['statements'] = [];
  for (const s of state.statements.filter(isActive)) {
    const key = accountKey(s);
    if (key === null) continue;
    const rows = state.rows.filter((r) => r.statement_id === s.id);
    statements.push({
      file_hash: s.file_hash,
      account_key: key,
      account_kind: s.account_kind,
      institution: s.institution,
      dedupe_keys: rows.map((r) => dedupeKey(key, r)),
      merchant_keys: [...new Set(rows.map((r) => r.merchant_key))],
    });
  }
  return { statements };
}

/** Mark duplicates (stored or repeated in this batch), prior files, debt suggestions and history. */
export function applyPreview(state: WizardState, preview: PreviewResponse): WizardState {
  const existing = new Set(preview.existing_dedupe_keys);
  const byId = new Map(state.statements.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const rows = state.rows.map((r) => {
    const stmt = byId.get(r.statement_id)!;
    const key = accountKey(stmt);
    if (key === null || stmt.skipped) return { ...r, duplicate: false };
    const dk = dedupeKey(key, r);
    const duplicate = existing.has(dk) || seen.has(dk);
    seen.add(dk);
    return { ...r, duplicate };
  });
  const statements = state.statements.map((s) => {
    const key = accountKey(s);
    const prior = preview.prior_files.find((p) => p.file_hash === s.file_hash);
    const suggestion = preview.liability_suggestions.find(
      (l) => l.file_hash === s.file_hash && (l.account_key ?? null) === key
    );
    return {
      ...s,
      prior_import_at: prior ? (prior.imported_at ?? '') : null,
      suggested_liability_id: suggestion?.liability_id ?? null,
    };
  });
  return { ...state, rows, statements, history: preview.history };
}

// ---------------------------------------------------------------- recurring

export function recurringRequest(state: WizardState, ref: RecurringReference): RecurringRequest {
  return {
    rows: activeRows(state)
      .filter((r) => !r.excluded && !r.duplicate)
      .map((r) => ({
        merchant_key: r.merchant_key,
        kind: r.kind,
        amount: r.amount,
        posted_date: r.posted_date,
        description: r.description,
        category_id: r.category_id,
      })),
    history: state.history,
    expenses: ref.expenses,
    categories: ref.categories,
  };
}

/** Replace the candidate list; one already in the budget starts unticked. */
export function setRecurring(
  state: WizardState,
  candidates: RecurringCandidateSuggestion[]
): WizardState {
  return { ...state, recurring: candidates.map((c) => ({ ...c, checked: !c.already_budgeted })) };
}

export type RecurringPatch = Partial<
  Pick<RecurringChoice, 'name' | 'amount' | 'frequency' | 'category_id' | 'checked'>
>;

export function updateRecurring(
  state: WizardState,
  merchantKey: string,
  patch: RecurringPatch
): WizardState {
  return {
    ...state,
    recurring: state.recurring.map((c) =>
      c.merchant_key === merchantKey ? { ...c, ...patch } : c
    ),
  };
}

/** Decisions the server accepts: a candidate with no category is left out. */
function recurringDecisions(state: WizardState): ApplyRecurring[] {
  const out: ApplyRecurring[] = [];
  for (const c of state.recurring) {
    const amount = Math.abs(c.amount);
    const name = c.name.trim().slice(0, 120);
    if (c.category_id === null || !name || !(amount > 0)) continue;
    const owner =
      state.statements.find(
        (s) =>
          !isLeftOut(s) &&
          state.rows.some((r) => r.statement_id === s.id && r.merchant_key === c.merchant_key)
      ) ?? state.statements.find((s) => !isLeftOut(s));
    if (!owner) continue;
    const decision: ApplyRecurring['decision'] = !c.checked
      ? 'reject'
      : c.matched_expense_id
        ? 'link'
        : 'create';
    out.push({
      merchant_key: c.merchant_key,
      name,
      amount,
      frequency: c.frequency,
      category_id: c.category_id,
      occurrences: Math.max(1, Math.round(c.occurrences)),
      file_hash: owner.file_hash,
      decision,
      ...(decision === 'link' ? { expense_id: c.matched_expense_id } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- AI categorize

function aiCategoryNames(
  categories: { id: string; name: string }[]
): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const c of categories) {
    const name = c.name.trim().slice(0, AI_MAX_CATEGORY_CHARS);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ id: c.id, name });
    if (out.length === AI_MAX_CATEGORIES) break;
  }
  return out;
}

/** Stable per-merchant item ids: position among all merchant keys in the batch. */
function merchantIds(state: WizardState): Map<string, string> {
  const ids = new Map<string, string>();
  for (const r of state.rows) {
    if (!ids.has(r.merchant_key)) ids.set(r.merchant_key, `m${ids.size}`);
  }
  return ids;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The AI request and its chunks. One item per unique uncategorized merchant of
 * spending rows; nothing else (no dates, descriptions, accounts or file names).
 * The disclosure panel renders `request` exactly; `chunks` are what is posted.
 */
export function buildCategorizeRequest(
  state: WizardState,
  categories: { id: string; name: string }[]
): { request: CategorizeRequest; chunks: CategorizeRequest[] } {
  const ids = merchantIds(state);
  const groups = new Map<string, WizardRow[]>();
  for (const r of activeRows(state)) {
    if (r.excluded || r.duplicate || r.category_id !== null) continue;
    if (!isSpending(r.kind) || AI_SKIP_KINDS.has(r.kind)) continue;
    const merchant = r.merchant_key.slice(0, AI_MAX_MERCHANT_CHARS);
    if ((merchant.match(/\p{L}/gu)?.length ?? 0) < AI_MIN_LETTERS) continue;
    const group = groups.get(r.merchant_key);
    if (group) group.push(r);
    else groups.set(r.merchant_key, [r]);
  }
  const items: CategorizeItem[] = [...groups].map(([key, rows]) => ({
    id: ids.get(key)!,
    merchant: key.slice(0, AI_MAX_MERCHANT_CHARS),
    typical_amount: Math.min(10_000_000, Math.round(median(rows.map((r) => Math.abs(r.amount))))),
    direction: rows.filter((r) => r.amount > 0).length > rows.length / 2 ? 'in' : 'out',
    count: rows.length,
  }));
  const names = aiCategoryNames(categories).map((c) => c.name);
  const request: CategorizeRequest = { categories: names, items };
  const chunks: CategorizeRequest[] = [];
  for (let i = 0; i < items.length; i += AI_MAX_ITEMS) {
    chunks.push({ categories: names, items: items.slice(i, i + AI_MAX_ITEMS) });
  }
  return { request, chunks };
}

/**
 * Apply AI suggestions to rows still without a category (never over a rule or
 * the user's choice). Unknown ids and category names are ignored.
 */
export function applyCategorizeResponse(
  state: WizardState,
  response: CategorizeResponse
): WizardState {
  const keyById = new Map([...merchantIds(state)].map(([key, id]) => [id, key]));
  const idByName = new Map(aiCategoryNames(state.categories).map((c) => [c.name, c.id]));
  const byKey = new Map<string, CategorizeResponse['suggestions'][number]>();
  for (const s of response.suggestions) {
    const key = keyById.get(s.id);
    if (key !== undefined) byKey.set(key, s);
  }
  const next = mapRows(state, (r) => {
    const s = byKey.get(r.merchant_key);
    if (!s || r.category_id !== null || !isSpending(r.kind)) return r;
    const kind = s.kind ?? r.kind;
    const categoryId = isSpending(kind) && s.category ? (idByName.get(s.category) ?? null) : null;
    if (categoryId === null && kind === r.kind) return r;
    return {
      ...r,
      kind,
      category_id: categoryId,
      category_source: categoryId === null ? 'none' : 'ai',
      ai_confidence: categoryId === null ? null : Math.min(1, Math.max(0, s.confidence)),
      reviewed: false,
    };
  });
  return { ...next, ai_provider: response.provider };
}

// ---------------------------------------------------------------- review edits

/** Row ids plus, when `remember`, every other row of the same merchants. */
function targetIds(
  state: WizardState,
  rowIds: string[],
  remember: boolean,
  only?: (r: WizardRow) => boolean
): Set<string> {
  const picked = new Set(rowIds);
  if (!remember) return picked;
  const keys = new Set(
    state.rows.filter((r) => picked.has(r.id) && (!only || only(r))).map((r) => r.merchant_key)
  );
  for (const r of state.rows) if (keys.has(r.merchant_key)) picked.add(r.id);
  return picked;
}

/** Set a category on spending rows; with `remember`, on every row of the same merchant. */
export function setCategory(
  state: WizardState,
  rowIds: string[],
  categoryId: string | null,
  remember: boolean
): WizardState {
  const targets = targetIds(state, rowIds, remember, (r) => isSpending(r.kind));
  const keys = new Set<string>();
  const next = mapRows(state, (r) => {
    if (!targets.has(r.id) || !isSpending(r.kind)) return r;
    keys.add(r.merchant_key);
    return {
      ...r,
      category_id: categoryId,
      category_source: categoryId === null ? 'none' : 'user',
      ai_confidence: null,
      reviewed: true,
    };
  });
  if (!remember) return next;
  const remembered = { ...next.remembered };
  for (const key of keys) remembered[key] = { ...remembered[key], category_id: categoryId };
  return { ...next, remembered };
}

/** Set a kind; a non-spending kind clears the category. With `remember`, applies to the merchant. */
export function setKind(
  state: WizardState,
  rowIds: string[],
  kind: SmartImportTxnKind,
  remember: boolean
): WizardState {
  const targets = targetIds(state, rowIds, remember);
  const keys = new Set<string>();
  const next = mapRows(state, (r) => {
    if (!targets.has(r.id)) return r;
    keys.add(r.merchant_key);
    return isSpending(kind)
      ? { ...r, kind }
      : {
          ...r,
          kind,
          category_id: null,
          category_source: 'none',
          ai_confidence: null,
          reviewed: false,
        };
  });
  if (!remember) return next;
  const remembered = { ...next.remembered };
  for (const key of keys) {
    remembered[key] = {
      ...remembered[key],
      kind,
      ...(isSpending(kind) ? {} : { category_id: null }),
    };
  }
  return { ...next, remembered };
}

export function setExcluded(state: WizardState, rowIds: string[], excluded: boolean): WizardState {
  const picked = new Set(rowIds);
  return mapRows(state, (r) => (picked.has(r.id) ? { ...r, excluded } : r));
}

/** Confirm AI suggestions (all, or the given rows) so they leave "Needs review". */
export function acceptAllSuggestions(state: WizardState, rowIds?: string[]): WizardState {
  const picked = rowIds ? new Set(rowIds) : null;
  return mapRows(state, (r) =>
    r.category_source === 'ai' && (!picked || picked.has(r.id)) ? { ...r, reviewed: true } : r
  );
}

export function filterRows(state: WizardState, filter: RowFilter): WizardRow[] {
  const rows = activeRows(state);
  switch (filter) {
    case 'review':
      return rows.filter(needsReview);
    case 'duplicates':
      return rows.filter((r) => r.duplicate);
    case 'excluded':
      return rows.filter((r) => r.excluded);
    default:
      return rows;
  }
}

// ---------------------------------------------------------------- apply

function applyRules(state: WizardState): ApplyRule[] {
  return Object.entries(state.remembered).map(([merchant_key, choice]) => ({
    merchant_key,
    ...(choice.category_id !== undefined ? { category_id: choice.category_id } : {}),
    ...(choice.kind !== undefined ? { kind: choice.kind } : {}),
    source: 'user' as const,
  }));
}

function applyTxn(row: WizardRow, key: string): ApplyTxn {
  const categorized = row.category_id !== null && isSpending(row.kind);
  return {
    posted_date: row.posted_date,
    amount: row.amount,
    description: row.description,
    merchant_key: row.merchant_key,
    kind: row.kind,
    category_id: categorized ? row.category_id : null,
    category_source: categorized && row.category_source !== 'none' ? row.category_source : 'none',
    ...(categorized && row.category_source === 'ai' && row.ai_confidence !== null
      ? { ai_confidence: row.ai_confidence }
      : {}),
    external_id: row.external_id,
    dedupe_key: dedupeKey(key, row),
    excluded: row.excluded,
  };
}

/**
 * The one POST /api/smart-import/apply body. Duplicates are left out; excluded
 * rows are sent as excluded. Skipped statements, files already imported and
 * statements with no account key or label are left out.
 */
export function buildApplyRequest(state: WizardState): ApplyRequest {
  const statements: ApplyStatement[] = [];
  for (const s of state.statements) {
    const key = accountKey(s);
    if (isLeftOut(s) || key === null) continue;
    const file = state.files.find((f) => f.id === s.file_id);
    const rows = state.rows.filter((r) => r.statement_id === s.id && !r.duplicate);
    const aiUsed = s.parser === 'pdf:ai' || rows.some((r) => r.category_source === 'ai');
    statements.push({
      file_hash: s.file_hash,
      file_name: s.file_name || file?.file_name || '',
      origin: s.origin,
      format: s.format,
      parser: s.parser,
      account: {
        kind: s.account_kind,
        key,
        label: s.account_label?.trim() || null,
        last4: s.last4,
        institution: s.institution,
      },
      period: s.period,
      closing_balance: s.closing_balance,
      liability_id: s.liability_id,
      ai_used: aiUsed,
      ...(aiUsed && state.ai_provider ? { ai_provider: state.ai_provider } : {}),
      transactions: rows.map((r) => applyTxn(r, key)),
    });
  }
  return {
    batch_id: state.batch_id,
    ...(state.entity_id ? { entity_id: state.entity_id } : {}),
    statements,
    rules: applyRules(state),
    recurring: recurringDecisions(state),
  };
}

export function reviewCounts(state: WizardState): ReviewCounts {
  const rows = activeRows(state);
  const decisions = recurringDecisions(state);
  const debts: ReviewCounts['debts'] = [];
  for (const s of state.statements) {
    if (isLeftOut(s) || s.liability_id === null || s.closing_balance === null) continue;
    debts.push({
      liability_id: s.liability_id,
      statement_id: s.id,
      label: s.account_label || s.institution || s.file_name,
      closing_balance: s.closing_balance.amount,
      as_of: s.closing_balance.as_of,
    });
  }
  return {
    new: rows.filter((r) => !r.duplicate && !r.excluded).length,
    duplicates: rows.filter((r) => r.duplicate).length,
    excluded: rows.filter((r) => !r.duplicate && r.excluded).length,
    needs_review: rows.filter(needsReview).length,
    merchants_to_remember: Object.keys(state.remembered).length,
    files_skipped: state.statements.filter(isLeftOut).length,
    expenses_to_add: decisions.filter((d) => d.decision === 'create').length,
    expenses_to_link: decisions.filter((d) => d.decision === 'link').length,
    debts,
  };
}
