/**
 * Debts page: summary strip and one card per liability, grouped by type, with
 * archived debts in a collapsed "Paid off" section, plus the detail view,
 * Update balance, Edit, Delete and the plain Add form. All data is written
 * with textContent.
 */

import { apiCall } from '@/api/client';
import { renderChart, ensureThemeUpdates, getAxisConfig } from '@/charts/plotly-utils';
import {
  openDebtForm,
  debtErrorMessage,
  applyFieldErrors,
  showFormError,
  submitOnEnter,
} from '@/features/debt-form';
import { store, subscribe } from '@/state/store';
import { on, emit } from '@/state/events';
import { createDynamicModal, closeDynamicModal } from '@/ui/modal';
import { onThemeChange } from '@/state/theme';
import { withSubmitGuard } from '@/ui/with-submit-guard';
import { onTabChange, getCurrentTab } from '@/ui/tabs';
import { setStateView } from '@/ui/state-view';
import { showToast } from '@/ui/toast';
import { formatCurrency } from '@/utils/format';
import {
  schedule,
  summarize as amortizationSummary,
  firstDueAfter,
  type ScheduleRow,
} from '@/utils/amortization';
import { today } from '@/utils/clock';
import {
  LIABILITY_TYPE_LABELS,
  formatApr,
  formatMonthDay,
  formatMonthYear,
} from '@/utils/liabilities';
import type {
  LiabilityFrequency,
  LiabilityHistoryResponse,
  LiabilityResponse,
  LiabilityType,
  RecordBalanceInput,
} from '@/types/api';

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
  title.appendChild(h('h3', 'debt-card-name', d.name));
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

  const actions = h('div', 'debt-card-actions');
  const act = (label: string, run: () => void): void => {
    const b = h('button', 'btn btn-default btn-sm', label);
    b.type = 'button';
    b.setAttribute('aria-label', `${label}: ${d.name}`);
    b.addEventListener('click', run);
    actions.appendChild(b);
  };
  act('Details', () => openDetail(d.id));
  act('Update balance', () => openBalanceDialog(d));
  act('Edit', () => openEdit(d));
  act('Delete', () => openDeleteDialog(d));
  card.appendChild(actions);
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
  add.addEventListener('click', openAdd);
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
  const toolbar = h('div', 'debts-toolbar');
  const addButton = h('button', 'btn btn-primary', 'Add a debt');
  addButton.type = 'button';
  addButton.setAttribute('data-debts-action', 'add');
  addButton.addEventListener('click', openAdd);
  toolbar.appendChild(addButton);
  host.appendChild(toolbar);

  // One grid across all types, ordered by type; each card carries its type.
  const active = list.filter((d) => d.is_active);
  const grid = h('div', 'debt-cards');
  for (const type of TYPE_ORDER) {
    const group = active.filter((d) => d.liability_type === type);
    if (group.length === 0) continue;
    for (const d of group) grid.appendChild(renderCard(d));
  }
  if (grid.childElementCount > 0) {
    host.appendChild(h('h2', 'visually-hidden', 'Your debts'));
    host.appendChild(grid);
  }

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

// ---------------------------------------------------------------------------
// Writes: Add, Edit, Update balance, Delete, relink
// ---------------------------------------------------------------------------

/**
 * Refresh the list after any write and tell the rest of the app (the
 * dashboard refetches its net worth). The page's own listener ignores this
 * emit, because the list is reloaded here.
 */
let emittingOwnChange = false;
type ChangeReason = 'added' | 'updated' | 'deleted' | 'balance';

async function afterWrite(reason: ChangeReason): Promise<void> {
  generation += 1;
  inflight = null;
  emittingOwnChange = true;
  try {
    emit({ type: 'liabilities:changed', reason });
  } finally {
    emittingOwnChange = false;
  }
  await loadDebts().catch(console.error);
}

function find(id: string): LiabilityResponse | undefined {
  return (all ?? []).find((d) => d.id === id);
}

/** PR C swaps the plain form for the wizard here. */
function openAdd(): void {
  openDebtForm({ entities: store.get('entities'), onSaved: () => afterWrite('added') });
}

function openEdit(d: LiabilityResponse, reopen = false): void {
  openDebtForm({
    debt: d,
    entities: store.get('entities'),
    onSaved: async () => {
      await afterWrite('updated');
      if (reopen) openDetail(d.id);
    },
  });
}

function parseMoney(raw: string): number {
  const t = raw.replace(/[$,\s]/g, '');
  return t === '' ? NaN : Number(t);
}

function formGroup(label: string, key: string, input: HTMLInputElement): HTMLElement {
  const wrap = h('div', 'form-group');
  const lab = h('label', undefined, label);
  input.id = `debt-field-${key}`;
  input.setAttribute('data-debt-field', key);
  lab.htmlFor = input.id;
  wrap.appendChild(lab);
  wrap.appendChild(input);
  return wrap;
}

function openBalanceDialog(d: LiabilityResponse, reopen = false): void {
  const form = h('form', 'debt-form');
  form.noValidate = true;
  form.addEventListener('submit', (e) => e.preventDefault());
  form.appendChild(h('p', 'debt-form-lead', `What does ${d.name} owe right now?`));
  const balance = h('input');
  balance.type = 'text';
  balance.inputMode = 'decimal';
  const asOf = h('input');
  asOf.type = 'date';
  const now = today();
  asOf.value = now;
  asOf.max = now;
  form.appendChild(formGroup('Balance', 'balance', balance));
  form.appendChild(formGroup('As of', 'asOf', asOf));

  const balanceModal = createDynamicModal({
    title: 'Update balance',
    content: form,
    saveButtonText: 'Save balance',
    modalClass: 'debt-form-modal',
    onSave: async (event) => {
      const errors: Record<string, string> = {};
      const amount = parseMoney(balance.value);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e10) {
        errors.balance = 'Enter an amount of zero or more';
      }
      // Compare calendar days as text, against the local clock.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf.value)) errors.asOf = 'Choose a date';
      else if (asOf.value > today()) errors.asOf = 'The date cannot be in the future';
      applyFieldErrors(form, errors);
      if (Object.keys(errors).length > 0) return;
      const body: RecordBalanceInput = { balance: amount, as_of: asOf.value };
      const button = event.currentTarget as HTMLButtonElement | null;
      try {
        await withSubmitGuard(button, 'Saving...', () =>
          apiCall(`/api/liabilities/${encodeURIComponent(d.id)}/balance`, {
            method: 'POST',
            body,
          })
        );
        closeDynamicModal();
        showToast('Balance updated', 'success');
        await afterWrite('balance');
        if (reopen) openDetail(d.id);
      } catch (error) {
        console.error('Balance update failed:', error instanceof Error ? error.name : 'error');
        showFormError(form, debtErrorMessage(error));
      }
    },
  });
  submitOnEnter(form, balanceModal);
  balance.focus();
}

function openDeleteDialog(d: LiabilityResponse): void {
  const body = h('div', 'debt-delete');
  body.appendChild(
    h(
      'p',
      undefined,
      `Delete ${d.name}? Its balance history is removed too. This cannot be undone.`
    )
  );
  let alsoExpense: HTMLInputElement | null = null;
  if (d.expense) {
    const label = h('label', 'debt-delete-option');
    alsoExpense = h('input');
    alsoExpense.type = 'checkbox';
    alsoExpense.checked = false;
    label.appendChild(alsoExpense);
    label.appendChild(h('span', undefined, 'Also delete the linked budget expense'));
    body.appendChild(label);
    body.appendChild(h('p', 'debt-field-hint', `Expense: ${d.expense.name}`));
  }
  const modal = createDynamicModal({
    title: 'Delete debt',
    content: body,
    saveButtonText: 'Delete',
    modalClass: 'modal-danger debt-form-modal',
    onSave: async (event) => {
      const button = event.currentTarget as HTMLButtonElement | null;
      const withExpense = alsoExpense?.checked === true;
      try {
        await withSubmitGuard(button, 'Deleting...', () =>
          apiCall(`/api/liabilities/${encodeURIComponent(d.id)}?delete_expense=${withExpense}`, {
            method: 'DELETE',
          })
        );
        closeDynamicModal();
        showToast('Debt deleted', 'success');
        await afterWrite('deleted');
      } catch (error) {
        console.error('Debt delete failed:', error instanceof Error ? error.name : 'error');
        showFormError(body, debtErrorMessage(error));
      }
    },
  });
  const save = modal.querySelector('[data-action="save"]');
  save?.classList.replace('btn-primary', 'btn-danger');
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

const CHART_ID = 'debt-detail-chart';

interface YearGroup {
  year: string;
  rows: ScheduleRow[];
}

/** First payment date strictly after today, like the server's _first_due_after. */
function firstDue(d: LiabilityResponse): string {
  return firstDueAfter(d.next_payment_date, d.payment_frequency || 'monthly', today());
}

/** Payments left, grouped by calendar year; null when there is no payoff plan. */
function scheduleYears(d: LiabilityResponse): YearGroup[] | 'never' | null {
  if (!d.is_amortizing || !d.payment_amount || d.estimated_balance <= 0) return null;
  const freq = d.payment_frequency || 'monthly';
  const apr = d.interest_rate ?? 0;
  const due = firstDue(d);
  if (amortizationSummary(d.estimated_balance, apr, d.payment_amount, freq, due).neverPaysOff) {
    return 'never';
  }
  const rows = schedule(d.estimated_balance, apr, d.payment_amount, freq, due);
  const groups: YearGroup[] = [];
  for (const row of rows) {
    const year = row.date.slice(0, 4);
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.rows.push(row);
    else groups.push({ year, rows: [row] });
  }
  return groups;
}

function renderSchedule(d: LiabilityResponse): HTMLElement | null {
  const years = scheduleYears(d);
  if (years === null) return null;
  const section = h('section', 'debt-detail-section');
  section.appendChild(h('h3', undefined, 'Payment schedule'));
  if (years === 'never') {
    section.appendChild(
      h(
        'p',
        'debt-field-hint',
        'At this payment the balance never reaches zero. Raise the payment to see a payoff plan.'
      )
    );
    return section;
  }
  for (const group of years) {
    const sum = (pick: (r: ScheduleRow) => number): number =>
      group.rows.reduce((total, r) => total + pick(r), 0);
    const details = h('details', 'debt-year');
    const summary = h('summary');
    summary.appendChild(h('span', 'debt-year-label', group.year));
    summary.appendChild(h('span', undefined, `Paid ${formatCurrency(sum((r) => r.payment))}`));
    summary.appendChild(h('span', undefined, `Interest ${formatCurrency(sum((r) => r.interest))}`));
    const end = group.rows[group.rows.length - 1]!;
    summary.appendChild(h('span', undefined, `Left ${formatCurrency(end.balance)}`));
    details.appendChild(summary);
    for (const row of group.rows) {
      const line = h('div', 'debt-year-row');
      line.appendChild(h('span', undefined, formatMonthDay(row.date)));
      line.appendChild(h('span', undefined, formatCurrency(row.payment)));
      line.appendChild(h('span', undefined, `Interest ${formatCurrency(row.interest)}`));
      line.appendChild(h('span', undefined, `Left ${formatCurrency(row.balance)}`));
      details.appendChild(line);
    }
    section.appendChild(details);
  }
  return section;
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

async function plotHistory(history: LiabilityHistoryResponse): Promise<void> {
  // Read at render time, so a re-render after a theme change picks up the new color.
  const color = cssVar('--color-primary', '#4f8cff');
  const traces = [
    {
      x: history.series.map((p) => p.date),
      y: history.series.map((p) => p.balance),
      type: 'scatter',
      mode: 'lines',
      name: 'Estimated balance',
      line: { color, width: 2 },
      hovertemplate: '%{x|%b %-d, %Y}: $%{y:,.2f}<extra></extra>',
    },
    {
      x: history.reported.map((p) => p.date),
      y: history.reported.map((p) => p.balance),
      type: 'scatter',
      mode: 'markers',
      name: 'Reported',
      marker: { color, size: 8 },
      hovertemplate: '%{x|%b %-d, %Y}: $%{y:,.2f} (reported)<extra></extra>',
    },
  ] as unknown as Parameters<typeof renderChart>[1];
  await renderChart(CHART_ID, traces, {
    height: 220,
    showlegend: false,
    margin: { t: 8, r: 12, b: 32, l: 64 },
    xaxis: { ...getAxisConfig(), type: 'date', nticks: 4, tickangle: 0, tickformat: '%b %Y' },
    yaxis: { ...getAxisConfig(), tickprefix: '$', tickformat: ',.0f' },
  });
}

async function drawHistory(id: string, host: HTMLElement): Promise<void> {
  try {
    const history = await apiCall<LiabilityHistoryResponse>(
      `/api/liabilities/${encodeURIComponent(id)}/history`
    );
    if (!host.isConnected) return;
    if (!history || !Array.isArray(history.series) || history.series.length === 0) {
      host.textContent = 'No balance history yet.';
      return;
    }
    host.textContent = '';
    await plotHistory(history);
    ensureThemeUpdates(CHART_ID);
    // The relayout above recolors axes; the line color is a trace property, so redraw.
    const stop = onThemeChange(() => {
      if (!host.isConnected) {
        stop();
        return;
      }
      plotHistory(history).catch(console.error);
    });
  } catch (error) {
    console.error('Debt history failed:', error instanceof Error ? error.name : 'error');
    if (host.isConnected) host.textContent = 'Balance history is not available right now.';
  }
}

interface RelinkKind {
  field: 'linked_position_id' | 'expense_id';
  noun: string;
  missing: string;
  list: () => Promise<Array<{ id: string; name: string }>>;
}

const RELINK: Record<'home' | 'expense', RelinkKind> = {
  home: {
    field: 'linked_position_id',
    noun: 'home',
    missing: 'The linked home was deleted or can no longer be found.',
    list: async () => {
      const rows = await apiCall<Array<{ id: string; name: string; position_type?: string }>>(
        '/api/portfolio/positions'
      );
      return (Array.isArray(rows) ? rows : []).filter((r) => r.position_type === 'real_estate');
    },
  },
  expense: {
    field: 'expense_id',
    noun: 'budget expense',
    missing: 'The linked budget expense was deleted or can no longer be found.',
    list: async () => {
      const rows = await apiCall<Array<{ id: string; name: string }>>('/api/budget/expenses');
      return Array.isArray(rows) ? rows : [];
    },
  },
};

async function relink(
  d: LiabilityResponse,
  kind: RelinkKind,
  value: string | null,
  host: HTMLElement,
  button: HTMLButtonElement
): Promise<void> {
  await withSubmitGuard(button, '', async () => {
    try {
      await apiCall(`/api/liabilities/${encodeURIComponent(d.id)}`, {
        method: 'PUT',
        body: { [kind.field]: value },
      });
      await afterWrite('updated');
      openDetail(d.id);
    } catch (error) {
      console.error('Relink failed:', error instanceof Error ? error.name : 'error');
      showFormError(host, debtErrorMessage(error));
    }
  });
}

function renderWarning(d: LiabilityResponse, which: 'home' | 'expense'): HTMLElement {
  const kind = RELINK[which];
  const box = h('div', 'debt-link-warning');
  box.setAttribute('role', 'status');
  box.appendChild(h('p', undefined, kind.missing));
  const row = h('div', 'debt-link-actions');
  const choose = h('button', 'btn btn-default btn-sm', 'Choose another');
  choose.type = 'button';
  const remove = h('button', 'btn btn-default btn-sm', 'Remove link');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    relink(d, kind, null, box, remove).catch(console.error);
  });
  choose.addEventListener('click', () => {
    kind
      .list()
      .then((options) => {
        row.textContent = '';
        const select = h('select');
        select.setAttribute('data-debt-relink', kind.field);
        select.setAttribute('aria-label', `Choose a ${kind.noun}`);
        for (const o of options) {
          const opt = h('option', undefined, o.name);
          opt.value = o.id;
          select.appendChild(opt);
        }
        const link = h('button', 'btn btn-primary btn-sm', 'Link');
        link.type = 'button';
        link.disabled = options.length === 0;
        link.addEventListener('click', () => {
          relink(d, kind, select.value, box, link).catch(console.error);
        });
        row.appendChild(
          options.length > 0
            ? select
            : h('span', 'debt-field-hint', `No ${kind.noun}s to choose from.`)
        );
        row.appendChild(link);
      })
      .catch((error: unknown) => {
        console.error('Relink options failed:', error instanceof Error ? error.name : 'error');
        showFormError(box, debtErrorMessage(error));
      });
  });
  row.appendChild(choose);
  row.appendChild(remove);
  box.appendChild(row);
  return box;
}

function openDetail(id: string): void {
  const d = find(id);
  if (!d) return;
  const body = h('div', 'debt-detail');
  body.appendChild(
    h(
      'p',
      'debt-detail-sub',
      [LIABILITY_TYPE_LABELS[d.liability_type], d.lender].filter(Boolean).join(' · ')
    )
  );

  const facts = h('dl', 'debt-card-facts');
  const fact = (label: string, value: string): void => {
    if (!value) return;
    const item = h('div', 'debt-card-fact');
    item.appendChild(h('dt', undefined, label));
    item.appendChild(h('dd', undefined, value));
    facts.appendChild(item);
  };
  fact('Estimated balance', formatCurrency(d.estimated_balance));
  fact('APR', d.interest_rate == null ? '' : formatApr(d.interest_rate));
  fact('Payment', paymentText(d));
  fact('Paid off', d.payoff_date ? formatMonthYear(d.payoff_date) : '');
  fact(
    'Interest left',
    d.total_interest_remaining == null ? '' : formatCurrency(d.total_interest_remaining)
  );
  fact('Last reported', d.last_reported_date ? formatMonthDay(d.last_reported_date) : '');
  body.appendChild(facts);

  const chart = h('div', 'debt-detail-chart');
  chart.id = CHART_ID;
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `Balance history for ${d.name}`);
  chart.textContent = 'Loading balance history...';
  const chartSection = h('section', 'debt-detail-section');
  chartSection.appendChild(h('h3', undefined, 'Balance history'));
  chartSection.appendChild(chart);
  body.appendChild(chartSection);

  const links = h('section', 'debt-detail-section');
  if (d.linked_position) {
    const value =
      d.linked_position.value == null ? '' : `, ${formatCurrency(d.linked_position.value)}`;
    links.appendChild(h('p', undefined, `Home: ${d.linked_position.name ?? 'Unnamed'}${value}`));
  }
  if (d.expense) {
    const monthly =
      d.expense.monthly_amount == null
        ? ''
        : `, ${formatCurrency(d.expense.monthly_amount)} a month`;
    links.appendChild(h('p', undefined, `Budget expense: ${d.expense.name}${monthly}`));
  }
  if (d.linked_position_missing) links.appendChild(renderWarning(d, 'home'));
  if (d.expense_missing) links.appendChild(renderWarning(d, 'expense'));
  if (links.childElementCount > 0) body.appendChild(links);

  const schedSection = renderSchedule(d);
  if (schedSection) body.appendChild(schedSection);

  const actions = h('div', 'debt-detail-actions');
  const act = (label: string, run: () => void, cls = 'btn btn-default'): void => {
    const b = h('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', run);
    actions.appendChild(b);
  };
  act('Update balance', () => openBalanceDialog(d, true), 'btn btn-primary');
  act('Edit', () => openEdit(d, true));
  act('Delete', () => openDeleteDialog(d));
  body.appendChild(actions);

  createDynamicModal({
    title: d.name,
    content: body,
    showFooter: false,
    modalClass: 'debt-detail-modal',
  });
  drawHistory(d.id, chart).catch(console.error);
}

let all: LiabilityResponse[] | null = null;
let inflight: Promise<void> | null = null;
let pendingId: string | null = null;
/** Bumped on invalidate so a response from before it is discarded. */
let generation = 0;

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

const HIGHLIGHT_MS = 2500;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

function clearHighlight(): void {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = null;
  document.querySelectorAll('.debt-card--highlight').forEach((el) => {
    el.classList.remove('debt-card--highlight');
  });
}

/**
 * Scroll to and highlight the requested debt once its card exists. While a
 * load is in flight the request is kept, because the fresh render replaces
 * the cards (and the highlight) that were on screen. After a completed load
 * the request is dropped even if the card is missing.
 */
function applyPending(fromLoad: boolean): void {
  if (!pendingId) return;
  const id = pendingId;
  const card = Array.from(document.querySelectorAll<HTMLElement>('[data-debt-id]')).find(
    (el) => el.getAttribute('data-debt-id') === id
  );
  if (!card) {
    if (fromLoad) {
      pendingId = null;
      const known = (all ?? []).some((d) => d.id === id);
      showToast(
        known ? 'This debt is hidden by the person filter' : 'That debt was not found',
        'info'
      );
    }
    return;
  }
  if (fromLoad || !inflight) pendingId = null;
  clearHighlight();
  const paidOff = card.closest('details');
  if (paidOff) paidOff.open = true;
  card.classList.add('debt-card--highlight');
  highlightTimer = setTimeout(clearHighlight, HIGHLIGHT_MS);
  card.addEventListener('blur', clearHighlight, { once: true });
  card.scrollIntoView({ block: 'center' });
  card.focus({ preventScroll: true });
}

/** Fetch every liability (archived included) and render the page. */
export function loadDebts(): Promise<void> {
  if (inflight) return inflight;
  const myGeneration = generation;
  inflight = (async (): Promise<void> => {
    try {
      const result = await apiCall<LiabilityResponse[]>('/api/liabilities?include_archived=true');
      if (myGeneration !== generation) return;
      if (!Array.isArray(result)) throw new TypeError('Unexpected liabilities response');
      all = result;
      render(true);
    } catch (error) {
      if (myGeneration !== generation) return;
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
      if (myGeneration === generation) inflight = null;
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

  // A debt changed somewhere else (not through this page): reload when visible.
  on('liabilities:changed', () => {
    if (emittingOwnChange) return;
    generation += 1;
    inflight = null;
    if (getCurrentTab() === 'debts') loadDebts().catch(console.error);
  });

  const invalidate = (): void => {
    generation += 1;
    all = null;
    inflight = null;
    pendingId = null;
    clearHighlight();
    const summary = document.getElementById('debts-summary');
    if (summary) summary.textContent = '';
    setStateView('#debts-list', { kind: 'loading', title: 'Loading debts' });
    if (getCurrentTab() === 'debts') loadDebts().catch(console.error);
  };
  on('profile:switched', invalidate);
  on('demo:toggled', invalidate);
}
