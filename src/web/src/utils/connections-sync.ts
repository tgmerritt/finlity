/**
 * Pure helpers for Sync now (connections design 9.2): which synced statements
 * are worth reviewing, the turns of at most 12 statements one Apply takes, the
 * mapping the wizard prefills, the mapping changes to write back after Apply,
 * and the fixed copy around a sync. Nothing here touches the DOM or the network.
 */

import { formatDate } from '@/utils/format';
import type {
  ConnectionAccount,
  ConnectionAccountError,
  ConnectionAccountRole,
  ConnectionAccountUpdate,
  ConnectionDetail,
  NormalizedStatement,
  PreviewRequest,
  PreviewResponse,
  UpdateConnectionRequest,
} from '@/types/api';
import type { WizardStatement } from '@/utils/smart-import-state';

/** One Apply takes at most 12 statements (MAX_APPLY_STATEMENTS). */
export const TURN_STATEMENTS = 12;

const isDebtKind = (kind: string): boolean => kind === 'credit_card' || kind === 'loan';

/** The key a statement of this account carries: its "same as" key, else its own. */
const keyOf = (a: Pick<ConnectionAccount, 'account_key' | 'same_as_key'>): string =>
  a.same_as_key ?? a.account_key;

export function accountFor(
  detail: Pick<ConnectionDetail, 'accounts'>,
  key: string | null
): ConnectionAccount | undefined {
  if (!key) return undefined;
  return (
    detail.accounts.find((a) => keyOf(a) === key) ??
    detail.accounts.find((a) => a.account_key === key)
  );
}

/** A debt account, or one linked to a debt: Apply can record a balance there. */
function takesBalance(a: ConnectionAccount | undefined): boolean {
  return !!a && (a.role === 'debt' || !!a.liability_id);
}

/**
 * Statements with something to review: any transaction, or a balance for an
 * account that is a debt or linked to one (the wizard can link it, and Apply
 * records the balance there). A balance alone on any other account changes
 * nothing, so it is dropped like an empty statement.
 */
export function reviewable(
  statements: readonly NormalizedStatement[],
  detail: Pick<ConnectionDetail, 'accounts'>
): NormalizedStatement[] {
  return statements.filter((s) => {
    if (s.transactions.length > 0) return true;
    if (!s.closing_balance) return false;
    return takesBalance(accountFor(detail, s.account.key));
  });
}

/** The read-only preview request that tells which synced rows are already stored. */
export function previewRequest(statements: readonly NormalizedStatement[]): PreviewRequest {
  return {
    statements: statements
      .filter((s) => s.account.key)
      .map((s) => ({
        file_hash: s.file_hash,
        account_key: s.account.key!,
        account_kind: s.account.kind,
        institution: s.account.institution,
        dedupe_keys: s.transactions.map((t) => `${s.account.key}|${t.dedupe_base}`),
        merchant_keys: [...new Set(s.transactions.map((t) => t.merchant_key))],
      })),
  };
}

/**
 * Leave out what a sync brings back that is already stored: a statement whose
 * window was applied before, or whose every row is a duplicate and that has no
 * debt balance to record. The wizard's own preview still marks the overlap rows
 * of the statements that stay.
 */
export function withSomethingNew(
  statements: readonly NormalizedStatement[],
  detail: Pick<ConnectionDetail, 'accounts'>,
  preview: Pick<PreviewResponse, 'existing_dedupe_keys' | 'prior_files'>
): NormalizedStatement[] {
  const stored = new Set(preview.existing_dedupe_keys ?? []);
  const prior = new Set((preview.prior_files ?? []).map((p) => p.file_hash));
  return statements.filter((s) => {
    if (prior.has(s.file_hash)) return false;
    const fresh = s.transactions.some((t) => !stored.has(`${s.account.key}|${t.dedupe_base}`));
    if (fresh) return true;
    return !!s.closing_balance && takesBalance(accountFor(detail, s.account.key));
  });
}

/**
 * The statements with each account's kind as the connection has it now. Turns
 * after the first call this with the mapping as the previous turn's write-back
 * left it, so a kind chosen in an earlier turn is not undone by a later one.
 */
export function withMappedKinds(
  statements: readonly NormalizedStatement[],
  detail: Pick<ConnectionDetail, 'accounts'>
): NormalizedStatement[] {
  return statements.map((s) => {
    const a = accountFor(detail, s.account.key);
    return a && a.kind !== s.account.kind ? { ...s, account: { ...s.account, kind: a.kind } } : s;
  });
}

/** Split into turns of at most `size` statements, keeping the oldest-first order. */
export function splitTurns<T>(items: readonly T[], size = TURN_STATEMENTS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The wizard's prefill: per statement key, the account's name, debt link and role. */
export function mappingFor(
  detail: Pick<ConnectionDetail, 'accounts'>
): Record<
  string,
  { liability_id: string | null; label: string | null; role: ConnectionAccountRole }
> {
  const out: Record<
    string,
    { liability_id: string | null; label: string | null; role: ConnectionAccountRole }
  > = {};
  for (const a of detail.accounts) {
    if (a.role === 'ignore') continue;
    out[keyOf(a)] = { liability_id: a.liability_id, label: a.label || null, role: a.role };
  }
  return out;
}

/**
 * The PUT /api/connections/{id} body for what the person changed in the wizard,
 * or null. Only applied connector statements of this connection count (skipped
 * ones and windows applied before do not); for an account synced in several
 * windows, the newest statement wins. A debt linked on an account that was not
 * a debt makes it one. Undo of an import does not undo what was written back
 * here: the mapping stays as the person last chose it.
 */
export function writeBackRequest(
  detail: Pick<ConnectionDetail, 'id' | 'accounts'>,
  statements: readonly WizardStatement[]
): UpdateConnectionRequest | null {
  const changes: Record<string, ConnectionAccountUpdate> = {};
  for (const s of statements) {
    if (s.origin !== 'connector' || s.connection_id !== detail.id) continue;
    if (s.skipped || s.prior_import_at !== null) continue;
    const a = accountFor(detail, s.account_key);
    if (!a) continue;
    const change: ConnectionAccountUpdate = {};
    if (s.account_kind !== a.kind) change.kind = s.account_kind;
    const liability = isDebtKind(s.account_kind) ? s.liability_id : null;
    if (liability !== a.liability_id) {
      change.liability_id = liability;
      if (liability !== null && a.role !== 'debt') change.role = 'debt';
    }
    if (Object.keys(change).length > 0) changes[a.provider_account_id] = change;
    else delete changes[a.provider_account_id];
  }
  return Object.keys(changes).length > 0 ? { accounts: changes } : null;
}

// ------------------------------------------------------------------ copy

export function noNewText(since: string): string {
  return `No new transactions since ${formatDate(since)}.`;
}

export function syncingText(label: string, part: number, total: number): string {
  return total > 1 ? `Syncing ${label}, part ${part} of ${total}...` : `Syncing ${label}...`;
}

/** The note above the account cards when a later window failed. */
export function stoppedText(done: number, total: number, reason: string): string {
  return `The sync stopped after part ${done} of ${total}. ${reason} The parts that finished are below; Sync now picks up the rest later.`;
}

export const NOTHING_TO_SYNC =
  'No account of this connection is set to sync. Choose them in Edit accounts.';

export const REST_NOT_OPENED = 'The rest of this sync was not opened. Sync now offers it again.';

/** One line per account the provider flagged, with the account's name in Finlity. */
export function accountErrorLines(
  errors: readonly ConnectionAccountError[],
  detail: Pick<ConnectionDetail, 'accounts'>,
  codeText: (code: string) => string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of errors) {
    const key = `${e.provider_account_id ?? ''}|${e.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const a = detail.accounts.find((x) => x.provider_account_id === e.provider_account_id);
    const name = a?.label || a?.name;
    out.push(name ? `${name}: ${codeText(e.code)}` : codeText(e.code));
  }
  return out;
}
