/**
 * Debts page: summary strip and one card per liability, grouped by type, with
 * archived debts in a collapsed "Paid off" section. All data is written with
 * textContent. Detail, edit and delete arrive with the detail view.
 */

import { apiCall } from '@/api/client';
import { store, subscribe } from '@/state/store';
import { on } from '@/state/events';
import { onTabChange, getCurrentTab } from '@/ui/tabs';
import { showToast } from '@/ui/toast';
import { formatCurrency } from '@/utils/format';
import { LIABILITY_TYPE_LABELS, formatApr, formatMonthYear } from '@/utils/liabilities';
import type { LiabilityFrequency, LiabilityResponse, LiabilityType } from '@/types/api';

const TYPE_ORDER = Object.keys(LIABILITY_TYPE_LABELS) as LiabilityType[];

const FREQUENCY_WORD: Record<LiabilityFrequency, string> = {
  weekly: 'week',
  biweekly: '2 weeks',
  monthly: 'month',
  quarterly: 'quarter',
  annual: 'year',
};

export interface DebtsSummary {
  totalOwed: number;
  monthlyPayments: number;
  /** Latest payoff date (ISO) among active debts that have one, else null. */
  debtFreeBy: string | null;
  /** Active debts with no payoff date, left out of debtFreeBy. */
  withoutPayoff: number;
}

export function summarize(list: readonly LiabilityResponse[]): DebtsSummary {
  const active = list.filter((d) => d.is_active);
  let latest: string | null = null;
  let withoutPayoff = 0;
  for (const d of active) {
    if (!d.payoff_date) {
      withoutPayoff += 1;
    } else if (!latest || d.payoff_date > latest) {
      latest = d.payoff_date;
    }
  }
  return {
    totalOwed: active.reduce((sum, d) => sum + d.estimated_balance, 0),
    monthlyPayments: active.reduce((sum, d) => sum + d.monthly_cash_flow, 0),
    debtFreeBy: latest,
    withoutPayoff,
  };
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function stat(label: string, value: string, note?: string): HTMLElement {
  const box = h('div', 'debts-stat');
  box.appendChild(h('span', 'debts-stat-label', label));
  box.appendChild(h('span', 'debts-stat-value', value));
  if (note) box.appendChild(h('span', 'debts-stat-note', note));
  return box;
}

function renderSummary(list: readonly LiabilityResponse[]): void {
  const host = document.getElementById('debts-summary');
  if (!host) return;
  host.textContent = '';
  if (!list.some((d) => d.is_active)) return;
  const s = summarize(list);
  host.appendChild(stat('Total owed', formatCurrency(s.totalOwed)));
  host.appendChild(stat('Monthly payments', formatCurrency(s.monthlyPayments)));
  const note =
    s.debtFreeBy && s.withoutPayoff > 0
      ? `Excludes ${s.withoutPayoff} ${s.withoutPayoff === 1 ? 'debt' : 'debts'} without a payoff plan`
      : undefined;
  host.appendChild(
    stat('Debt-free by', s.debtFreeBy ? formatMonthYear(s.debtFreeBy) : 'Not projected', note)
  );
}

/** Percent of the original principal repaid, or null when it cannot be known. */
function paidPercent(d: LiabilityResponse): number | null {
  if (!d.is_amortizing || !d.original_principal || d.original_principal <= 0) return null;
  const pct = (1 - d.estimated_balance / d.original_principal) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)));
}

function paymentText(d: LiabilityResponse): string {
  if (!d.payment_amount) return '';
  const word = FREQUENCY_WORD[d.payment_frequency as LiabilityFrequency];
  return `${formatCurrency(d.payment_amount)}${word ? ` / ${word}` : ''}`;
}

function renderCard(d: LiabilityResponse): HTMLElement {
  const card = h('article', d.is_active ? 'debt-card' : 'debt-card debt-card--paid');
  card.setAttribute('data-debt-id', d.id);
  card.tabIndex = -1;

  card.appendChild(h('span', 'debt-card-type', LIABILITY_TYPE_LABELS[d.liability_type]));
  const top = h('div', 'debt-card-top');
  const title = h('div', 'debt-card-title');
  title.appendChild(h('h4', 'debt-card-name', d.name));
  if (d.lender) title.appendChild(h('span', 'debt-card-lender', d.lender));
  top.appendChild(title);
  top.appendChild(h('span', 'debt-card-balance', formatCurrency(d.estimated_balance)));
  card.appendChild(top);

  const facts = h('dl', 'debt-card-facts');
  const fact = (label: string, value: string): void => {
    if (!value) return;
    const item = h('div', 'debt-card-fact');
    item.appendChild(h('dt', undefined, label));
    item.appendChild(h('dd', undefined, value));
    facts.appendChild(item);
  };
  fact('APR', d.interest_rate == null ? '' : formatApr(d.interest_rate));
  fact('Payment', paymentText(d));
  fact('Paid off', d.payoff_date ? formatMonthYear(d.payoff_date) : '');
  if (facts.childElementCount > 0) card.appendChild(facts);

  const pct = paidPercent(d);
  if (pct !== null) {
    const bar = h('div', 'debt-progress');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${d.name} paid off`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(pct));
    const fill = h('span', 'debt-progress-fill');
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
    card.appendChild(h('span', 'debt-progress-label', `${pct}% paid`));
  }

  // Update balance, Edit and Delete land here with the detail view.
  card.appendChild(h('div', 'debt-card-actions'));
  return card;
}

function renderEmpty(host: HTMLElement): void {
  const box = h('section', 'card debts-empty');
  const body = h('div', 'card-body');
  body.appendChild(h('h2', undefined, 'Add your debts to see your net worth'));
  body.appendChild(
    h('p', undefined, 'Mortgages, loans and credit cards count against what you own.')
  );
  const add = h('button', 'btn btn-primary', 'Add a debt');
  add.type = 'button';
  add.setAttribute('data-debts-action', 'add');
  add.addEventListener('click', () => {
    showToast('Adding a debt is not available yet.', 'info');
  });
  body.appendChild(add);
  box.appendChild(body);
  host.appendChild(box);
}

function renderList(list: readonly LiabilityResponse[]): void {
  const host = document.getElementById('debts-list');
  if (!host) return;
  host.textContent = '';
  if (list.length === 0) {
    renderEmpty(host);
    return;
  }

  // One grid across all types, ordered by type; each card carries its type.
  const active = list.filter((d) => d.is_active);
  const grid = h('div', 'debt-cards');
  for (const type of TYPE_ORDER) {
    const group = active.filter((d) => d.liability_type === type);
    if (group.length === 0) continue;
    for (const d of group) grid.appendChild(renderCard(d));
  }
  if (grid.childElementCount > 0) host.appendChild(grid);

  const paid = list.filter((d) => !d.is_active);
  if (paid.length > 0) {
    const details = h('details', 'debts-paid-off');
    details.appendChild(h('summary', undefined, `Paid off (${paid.length})`));
    const cards = h('div', 'debt-cards');
    for (const d of paid) cards.appendChild(renderCard(d));
    details.appendChild(cards);
    host.appendChild(details);
  }
}

let all: LiabilityResponse[] | null = null;
let inflight: Promise<void> | null = null;
let pendingId: string | null = null;

function visible(): LiabilityResponse[] {
  const entityId = store.get('currentEntityId');
  return (all ?? []).filter((d) => !entityId || d.entity_id === entityId);
}

function render(fromLoad = false): void {
  const list = visible();
  renderSummary(list);
  renderList(list);
  applyPending(fromLoad);
}

/**
 * Scroll to and highlight the requested debt once its card exists. While a
 * load is in flight the request is kept, because the fresh render replaces
 * the cards (and the highlight) that were on screen.
 */
function applyPending(fromLoad: boolean): void {
  if (!pendingId) return;
  const id = pendingId;
  const card = Array.from(document.querySelectorAll<HTMLElement>('[data-debt-id]')).find(
    (el) => el.getAttribute('data-debt-id') === id
  );
  if (!card) return;
  if (fromLoad || !inflight) pendingId = null;
  document.querySelectorAll('.debt-card--highlight').forEach((el) => {
    el.classList.remove('debt-card--highlight');
  });
  const paidOff = card.closest('details');
  if (paidOff) paidOff.open = true;
  card.classList.add('debt-card--highlight');
  card.scrollIntoView({ block: 'center' });
  card.focus({ preventScroll: true });
}

/** Fetch every liability (archived included) and render the page. */
export function loadDebts(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async (): Promise<void> => {
    try {
      all = await apiCall<LiabilityResponse[]>('/api/liabilities?include_archived=true');
      render(true);
    } catch (error) {
      // Log the error type only: never balances, names or server detail.
      console.error('Debts load failed:', error instanceof Error ? error.name : 'error');
      all = null;
      pendingId = null;
      const summary = document.getElementById('debts-summary');
      if (summary) summary.textContent = '';
      const host = document.getElementById('debts-list');
      if (host) {
        host.textContent = '';
        const box = h('section', 'card debts-empty');
        const body = h('div', 'card-body');
        body.appendChild(h('h2', undefined, 'Could not load your debts'));
        body.appendChild(h('p', undefined, 'Check your connection and try again.'));
        const retry = h('button', 'btn btn-default', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', () => {
          loadDebts().catch(console.error);
        });
        body.appendChild(retry);
        box.appendChild(body);
        host.appendChild(box);
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function initDebts(): void {
  onTabChange((tab) => {
    if (tab === 'debts') loadDebts().catch(console.error);
  });

  // The request can arrive before the list has loaded (showTab then emit), so
  // keep the id until its card exists.
  on('debts:open', (event) => {
    pendingId = event.id;
    // Refresh first: the debt may be newer than the cached list.
    if (!inflight) loadDebts().catch(console.error);
    applyPending(false);
  });

  subscribe('currentEntityId', () => {
    if (all) render();
  });

  const invalidate = (): void => {
    all = null;
    if (getCurrentTab() === 'debts') loadDebts().catch(console.error);
  };
  on('profile:switched', invalidate);
  on('demo:toggled', invalidate);
}
