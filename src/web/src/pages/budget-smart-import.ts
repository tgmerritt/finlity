/**
 * Budget > Expenses: the import history (with per-upload Undo) and the planned
 * vs actual card. Both read what the import wizard stored; the wizard itself is
 * a lazy chunk opened from features/bank-statements.ts.
 *
 * budget.ts hands in the two actions that live there (Add Expense dialog and the
 * expenses reload), so this module never imports the page that loads it.
 */

import { apiCall, ApiError } from '@/api/client';
import { store } from '@/state/store';
import { emit } from '@/state/events';
import { formatCurrency, formatDate } from '@/utils/format';
import { button, countText, el, keptLines, undoRefusedText } from '@/utils/smart-import-render';
import {
  dismissSyncDue,
  historyLabel,
  isSyncDue,
  lastSyncedText,
  providerLabel,
  statusNote,
  syncGate,
} from '@/utils/connections-render';
import { noteNode, whileBusy } from '@/utils/connections-note';
import type {
  ConnectionSummary,
  SmartImportSummary,
  SmartImportUndoResponse,
  SpendingSummary,
} from '@/types/api';

export interface ImportCardDeps {
  /** Open the Add Expense dialog prefilled (the category id is the API's). */
  addToPlan: (prefill: { category_id: string; amount: number }) => void;
  /** Reload the expenses list. */
  refresh: () => Promise<void>;
}

const HISTORY_ERROR = 'Import history could not be loaded. Try again in a moment.';
const SUMMARY_ERROR = 'Planned vs actual could not be loaded. Try again in a moment.';
const UNDO_ERROR = 'That import could not be undone. Nothing was changed. Try again in a moment.';
const KIND_LABEL: Record<string, string> = {
  checking: 'Checking account',
  savings: 'Savings account',
  credit_card: 'Credit card',
  loan: 'Loan',
};

/** "a", "a and b", "a, b and c". */
function joinParts(parts: string[]): string {
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function host(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setStatus(lines: string[]): void {
  const box = host('smart-import-history-status');
  if (!box) return;
  box.textContent = '';
  for (const line of lines) box.appendChild(el('span', 'import-history-status-line', line));
  // The row that held the focus may be gone after a reload; the result takes it.
  box.focus();
}

// ------------------------------------------------------------------ history

function accountText(i: SmartImportSummary): string {
  const kind = KIND_LABEL[i.account_kind] ?? 'Account';
  const last4 = i.account_last4 ? `${kind} ending ${i.account_last4}` : kind;
  return i.account_label ? `${i.account_label} (${last4})` : last4;
}

function periodLine(i: SmartImportSummary): string {
  if (!i.period_start && !i.period_end) return '';
  return `${formatDate(i.period_start)} to ${formatDate(i.period_end)}`;
}

function countsLine(i: SmartImportSummary): string {
  const parts = [`${i.txn_new.toLocaleString('en-US')} new`];
  if (i.txn_duplicate) parts.push(`${i.txn_duplicate.toLocaleString('en-US')} already imported`);
  if (i.txn_excluded) parts.push(`${i.txn_excluded.toLocaleString('en-US')} left out`);
  return parts.join(', ');
}

/** Worded like the wizard's Done step confirm, which counts the same things. */
function confirmText(i: SmartImportSummary): string {
  const txns = countText(i.txn_new, 'transaction');
  const removes =
    i.liability_id && i.closing_balance !== null
      ? `${txns}, expenses it added unless you changed them, and debt balances it recorded`
      : `${txns} and expenses it added unless you changed them`;
  return `Undo this import? Removes ${removes}. Remembered merchants stay.`;
}

function removedText(r: SmartImportUndoResponse): string[] {
  const parts = [countText(r.deleted?.transactions ?? 0, 'transaction')];
  if (r.deleted?.expenses) parts.push(countText(r.deleted.expenses, 'expense'));
  if (r.deleted?.snapshots) parts.push(countText(r.deleted.snapshots, 'debt balance'));
  const lines = [`Removed ${joinParts(parts)}.`, ...keptLines(r.kept ?? [])];
  const moved = r.reassigned?.transactions ?? 0;
  if (moved) {
    lines.push(
      `${countText(moved, 'transaction')} also in another import now ${moved === 1 ? 'belongs' : 'belong'} to that import.`
    );
  }
  lines.push('Remembered merchants stay.');
  return lines;
}

function renderRow(
  i: SmartImportSummary,
  deps: ImportCardDeps,
  connections: readonly ConnectionSummary[] | null
): HTMLElement {
  const row = el('li', 'import-history-row');
  const info = el('div', 'import-history-info');
  const title = el('div', 'import-history-title');
  const synced = historyLabel(i, connections);
  const name = synced?.title ?? i.file_name;
  title.appendChild(el('span', 'import-history-file', name));
  if (i.origin === 'sample') title.appendChild(el('span', 'import-history-chip', 'Sample'));
  if (synced?.removed) title.appendChild(el('span', 'import-history-chip', 'Connection removed'));
  info.appendChild(title);
  info.appendChild(el('div', 'import-history-meta', accountText(i)));
  const period = periodLine(i);
  info.appendChild(
    el('div', 'import-history-meta', period ? `${period}. ${countsLine(i)}` : countsLine(i))
  );
  row.appendChild(info);

  const actions = el('div', 'import-history-actions');
  const undo = button('Undo', 'btn btn-secondary btn-sm', 'undo');
  undo.setAttribute('data-si-history', 'undo');
  undo.setAttribute('aria-label', `Undo import of ${name}`);
  actions.appendChild(undo);
  row.appendChild(actions);

  undo.addEventListener('click', () => {
    undo.hidden = true;
    const box = el('div', 'import-history-confirm');
    box.setAttribute('role', 'alert');
    box.appendChild(el('p', 'import-history-confirm-text', confirmText(i)));
    const keep = button('Keep it', 'btn btn-secondary btn-sm', 'keep');
    keep.setAttribute('data-si-history', 'keep');
    const go = button('Undo import', 'btn btn-danger btn-sm', 'confirm');
    go.setAttribute('data-si-history', 'confirm');
    const buttons = el('div', 'import-history-confirm-actions');
    buttons.append(keep, go);
    box.appendChild(buttons);
    row.appendChild(box);
    keep.focus();
    keep.addEventListener('click', () => {
      box.remove();
      undo.hidden = false;
      undo.focus();
    });
    go.addEventListener('click', () => {
      keep.disabled = true;
      go.disabled = true;
      go.textContent = 'Undoing...';
      void runUndo(i, deps).then((ok) => {
        if (ok || !row.isConnected) return;
        keep.disabled = false;
        go.disabled = false;
        go.textContent = 'Undo import';
      });
    });
  });
  return row;
}

async function runUndo(i: SmartImportSummary, deps: ImportCardDeps): Promise<boolean> {
  let lines: string[];
  try {
    const result = await apiCall<SmartImportUndoResponse>(
      `/api/smart-import/imports/${encodeURIComponent(i.import_id)}`,
      { method: 'DELETE' }
    );
    lines = removedText(result);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      lines = ['That import was already undone.'];
    } else {
      console.error('Import undo failed:', error instanceof Error ? error.name : 'error');
      setStatus([undoRefusedText(error) ?? UNDO_ERROR]);
      return false;
    }
  }
  emit({ type: 'liabilities:changed', reason: 'balance' });
  await Promise.allSettled([deps.refresh(), loadImportHistory(deps), loadPlannedVsActual(deps)]);
  setStatus(lines);
  return true;
}

/**
 * `connectionList` lets a caller share one /api/connections request with the
 * connections card; without it the list is fetched here.
 */
export async function loadImportHistory(
  deps: ImportCardDeps,
  connectionList?: Promise<ConnectionSummary[] | null>
): Promise<void> {
  const list = host('smart-import-history-list');
  if (!list) return;
  let imports: SmartImportSummary[];
  try {
    imports = (await apiCall<SmartImportSummary[]>('/api/smart-import/imports')) ?? [];
  } catch (error) {
    console.error('Import history load failed:', error instanceof Error ? error.name : 'error');
    list.textContent = HISTORY_ERROR;
    return;
  }
  // Provider names for synced imports; unknown (null) when the list cannot load.
  const connections = await (connectionList ?? loadConnectionList());
  list.textContent = '';
  if (imports.length === 0) {
    list.appendChild(
      el('p', 'empty-state', 'No imports yet. Statements you import are listed here.')
    );
    return;
  }
  // The API lists newest first; a batch sits where its newest upload is.
  const batches = new Map<string, SmartImportSummary[]>();
  for (const i of imports) {
    const group = batches.get(i.batch_id) ?? [];
    group.push(i);
    batches.set(i.batch_id, group);
  }
  for (const group of batches.values()) {
    const batch = el('section', 'import-history-batch');
    const head = el('div', 'import-history-batch-head');
    head.appendChild(
      el('h5', 'import-history-batch-title', `Imported ${formatDate(group[0]!.imported_at)}`)
    );
    head.appendChild(
      el('span', 'import-history-batch-count', countText(group.length, 'statement'))
    );
    batch.appendChild(head);
    const rows = el('ul', 'import-history-rows');
    for (const i of group) rows.appendChild(renderRow(i, deps, connections));
    batch.appendChild(rows);
    list.appendChild(batch);
  }
}

// -------------------------------------------------------------- connections

async function loadConnectionList(): Promise<ConnectionSummary[] | null> {
  try {
    return (await apiCall<ConnectionSummary[]>('/api/connections')) ?? [];
  } catch {
    return null;
  }
}

function daysAgoText(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return days <= 1 ? 'Last synced 1 day ago.' : `Last synced ${days} days ago.`;
}

function connectionRow(c: ConnectionSummary, now: Date, reload: () => Promise<void>): HTMLElement {
  const row = el('li', 'import-connection');
  const info = el('div', 'import-connection-info');
  const title = el('div', 'import-connection-title');
  title.appendChild(el('strong', 'import-connection-label', c.label));
  title.appendChild(el('span', 'import-connection-provider', providerLabel(c.provider)));
  info.appendChild(title);
  info.appendChild(el('p', 'import-connection-meta', lastSyncedText(c)));
  const note = statusNote(c, now);
  if (note) info.appendChild(noteNode(note));
  if (isSyncDue(c, now) && c.last_synced_at) {
    const due = el('div', 'import-connection-due');
    due.appendChild(
      el(
        'span',
        'import-connection-due-text',
        `${daysAgoText(c.last_synced_at, now)} Sync now to check for new transactions.`
      )
    );
    const dismiss = button('Dismiss', 'btn btn-secondary btn-sm', 'dismiss');
    dismiss.setAttribute('data-si-conn', 'dismiss');
    dismiss.setAttribute('aria-label', `Dismiss the sync reminder for ${c.label}`);
    dismiss.addEventListener('click', () => {
      dismissSyncDue(c.id);
      // Keep focus in the card: the button is about to leave the DOM.
      const sync = row.querySelector<HTMLButtonElement>('[data-si-conn="sync"]');
      const box = host('import-connections');
      if (sync && !sync.disabled) {
        sync.focus();
      } else if (box) {
        if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
        box.focus();
      }
      due.remove();
    });
    due.appendChild(dismiss);
    info.appendChild(due);
  }
  row.appendChild(info);

  const actions = el('div', 'import-connection-actions');
  const sync = button('Sync now', 'btn btn-primary btn-sm', 'sync');
  sync.setAttribute('data-si-conn', 'sync');
  sync.setAttribute('aria-label', `Sync ${c.label} now`);
  sync.disabled = syncGate(c, now).blocked;
  sync.addEventListener('click', () => {
    void whileBusy(sync, !syncGate(c, now).blocked, () =>
      import('@/features/connections')
        .then(({ syncNow }) => syncNow(c.id, reload, 'import-connections-status'))
        .catch(() => setConnectionStatus(['Could not start the sync. Try again in a moment.']))
    );
  });
  actions.appendChild(sync);
  if (c.status === 'reconnect_needed') {
    const reconnect = button('Reconnect', 'btn btn-primary btn-sm', 'reconnect');
    reconnect.setAttribute('data-si-conn', 'reconnect');
    reconnect.setAttribute('aria-label', `Reconnect ${c.label}`);
    reconnect.addEventListener('click', () => {
      void import('@/features/connections')
        .then(({ openConnectDialog }) => openConnectDialog({ reconnect: c, onChanged: reload }))
        .catch(() => setConnectionStatus(['Could not open Reconnect. Try again in a moment.']));
    });
    actions.appendChild(reconnect);
  }
  row.appendChild(actions);
  return row;
}

function setConnectionStatus(lines: string[]): void {
  const box = host('import-connections-status');
  if (!box) return;
  box.textContent = '';
  for (const line of lines) box.appendChild(el('span', 'import-history-status-line', line));
}

/**
 * The connections with Sync now. Hidden when there are none or the list fails.
 * `connectionList` shares one /api/connections request with the import history.
 */
export async function loadConnectionsCard(
  deps: ImportCardDeps,
  connectionList?: Promise<ConnectionSummary[] | null>
): Promise<void> {
  const box = host('import-connections');
  const list = host('import-connections-list');
  if (!box || !list) return;
  const connections = await (connectionList ?? loadConnectionList());
  list.textContent = '';
  if (!connections || connections.length === 0) {
    box.hidden = true;
    return;
  }
  const now = new Date();
  // A recorded sync changes last synced and quota, and may add history rows.
  const reload = async (): Promise<void> => {
    const shared = loadConnectionList();
    await Promise.allSettled([loadConnectionsCard(deps, shared), loadImportHistory(deps, shared)]);
  };
  for (const c of connections) list.appendChild(connectionRow(c, now, reload));
  box.hidden = false;
}

// ------------------------------------------------------------ planned vs actual

function monthLabel(month: string): string {
  return formatDate(`${month}-01`, { month: 'short', year: 'numeric' });
}

function differenceText(diff: number): string {
  if (Math.abs(diff) < 0.005) return 'On plan';
  return `${formatCurrency(Math.abs(diff))} ${diff > 0 ? 'over' : 'under'} plan`;
}

function renderCategory(
  line: SpendingSummary['categories'][number],
  scale: number,
  deps: ImportCardDeps
): HTMLElement {
  const row = el('li', 'pva-row');
  const head = el('div', 'pva-head');
  head.appendChild(el('span', 'pva-name', line.category_name));
  const diff = el('span', 'pva-diff', differenceText(line.difference));
  if (line.difference > 0.005) diff.classList.add('pva-diff--over');
  else if (line.difference < -0.005) diff.classList.add('pva-diff--under');
  head.appendChild(diff);
  row.appendChild(head);

  const bars = el('div', 'pva-bars');
  bars.setAttribute('aria-hidden', 'true');
  const pct = (value: number): string => `${Math.round((value / scale) * 1000) / 10}%`;
  const bar = (kind: 'planned' | 'actual', value: number): HTMLElement => {
    const node = el('span', `pva-bar pva-bar--${kind}`);
    node.style.width = pct(value);
    // A real amount never vanishes next to a large one; zero stays empty.
    if (value > 0) node.style.minWidth = '2px';
    return node;
  };
  const planned = bar('planned', line.planned_monthly);
  const actual = bar('actual', line.actual_monthly);
  bars.append(planned, actual);
  row.appendChild(bars);

  const foot = el('div', 'pva-foot');
  foot.appendChild(
    el(
      'span',
      'pva-values',
      `Planned ${formatCurrency(line.planned_monthly)}/mo. Actual ${formatCurrency(line.actual_monthly)}/mo.`
    )
  );
  if (line.category_id && line.actual_monthly > 0 && line.planned_monthly === 0) {
    const add = el('button', 'btn btn-secondary btn-sm', 'Add to plan');
    add.type = 'button';
    add.setAttribute('data-si-pva', 'add');
    add.setAttribute('aria-label', `Add ${line.category_name} to your plan`);
    const categoryId = line.category_id;
    add.addEventListener('click', () =>
      deps.addToPlan({
        category_id: categoryId,
        amount: Math.round(line.actual_monthly * 100) / 100,
      })
    );
    foot.appendChild(add);
  }
  row.appendChild(foot);
  return row;
}

export async function loadPlannedVsActual(deps: ImportCardDeps): Promise<void> {
  const body = host('planned-actual-body');
  if (!body) return;
  let summary: SpendingSummary;
  try {
    const entity = store.get('currentEntityId');
    const query = `months=3${entity ? `&entity_id=${encodeURIComponent(entity)}` : ''}`;
    summary = await apiCall<SpendingSummary>(`/api/budget/spending-summary?${query}`);
  } catch (error) {
    console.error('Spending summary load failed:', error instanceof Error ? error.name : 'error');
    body.textContent = SUMMARY_ERROR;
    return;
  }
  body.textContent = '';
  const months = summary.months ?? [];
  if (!summary.months_covered || months.length === 0) {
    body.appendChild(
      el('p', 'empty-state', 'Import a statement to see how your spending compares to your plan.')
    );
    return;
  }
  const span =
    months.length > 1
      ? `${monthLabel(months[0]!)} to ${monthLabel(months[months.length - 1]!)}`
      : monthLabel(months[0]!);
  body.appendChild(
    el(
      'p',
      'pva-note',
      `Monthly average over ${countText(summary.months_covered, 'month')} of imported statements (${span}).`
    )
  );
  const legend = el('p', 'pva-legend');
  legend.appendChild(el('span', 'pva-key pva-key--planned', 'Planned'));
  legend.appendChild(el('span', 'pva-key pva-key--actual', 'Actual'));
  body.appendChild(legend);

  const scale =
    Math.max(
      ...summary.categories.map((c) => Math.max(c.planned_monthly, c.actual_monthly)),
      0.01
    ) || 1;
  const list = el('ul', 'pva-list');
  for (const line of summary.categories) list.appendChild(renderCategory(line, scale, deps));
  body.appendChild(list);

  const totals = summary.totals;
  const total = el('div', 'pva-total');
  total.appendChild(el('span', 'pva-name', 'Total'));
  total.appendChild(
    el(
      'span',
      'pva-values',
      `Planned ${formatCurrency(totals.planned_monthly)}/mo. Actual ${formatCurrency(totals.actual_monthly)}/mo. ${differenceText(totals.difference)}.`
    )
  );
  body.appendChild(total);
}

/** Load both cards. Each shows its own fixed message when its request fails. */
export async function loadImportCards(deps: ImportCardDeps): Promise<void> {
  // One /api/connections request feeds both the card and the history labels.
  const connections = loadConnectionList();
  await Promise.allSettled([
    loadConnectionsCard(deps, connections),
    loadImportHistory(deps, connections),
    loadPlannedVsActual(deps),
  ]);
}
