/**
 * Dashboard page module.
 * Handles main data loading, summary updates, and dashboard widgets.
 */

import { apiCall } from '@/api/client';
import { store } from '@/state/store';
import { emit, on } from '@/state/events';
import { showLoading, hideLoading } from '@/ui/loading';
import { showToast } from '@/ui/toast';
import { onTabChange, showTab } from '@/ui/tabs';
import { withSubmitGuard } from '@/ui/with-submit-guard';
import { closeModal, showConfirmDialog, createDynamicModal } from '@/ui/modal';
import { formatCurrency } from '@/utils/format';
import {
  allocationVsTarget,
  attentionItems,
  defaultRange,
  groupAccounts,
  hasTargets,
  historyChange,
  portfolioDayChange,
  type AttentionItem,
  type Change,
  type RangeKey,
  type TriggeredAlert,
} from '@/utils/portfolio-metrics';
import { applyHistoryRange, setHistoryRange, updateHistoryChart } from '@/charts/allocation';
import { loadWidgets } from '@/features/plugins';
import { updateAccountFilterLabel } from '@/pages/holdings';
import { updateDemoModeUI } from '@/features/onboarding';
import type { DashboardData, DashboardPosition, SnapshotHistory } from '@/types/api';

/**
 * Duplicate position data.
 */
interface DuplicateInfo {
  ticker: string;
  shares: number;
  reason: string;
  positions: Array<{
    id: string;
    account_name: string;
    value: number;
  }>;
}

/**
 * Duplicates response from API.
 */
interface DuplicatesResponse {
  has_duplicates: boolean;
  count: number;
  duplicates: DuplicateInfo[];
}

/**
 * Price status response from API.
 */
interface PriceStatusResponse {
  all_fresh: boolean;
  newest_update?: string;
  stale_tickers: number;
  market_open?: boolean;
  next_refresh_at?: string | null;
}

/**
 * Price refresh response from API.
 */
interface PriceRefreshResponse {
  all_fresh: boolean;
  updated: number;
  attempted?: number;
  failed?: number;
  failed_tickers?: string[];
  message?: string;
  market_open?: boolean;
  next_refresh_at?: string | null;
}

// Module-level state for duplicates
let duplicatesData: DuplicateInfo[] = [];

/**
 * Create a trash/delete SVG icon element.
 */
function createDeleteIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');

  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '3 6 5 6 21 6');
  svg.appendChild(polyline);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'
  );
  svg.appendChild(path);

  return svg;
}

/**
 * Refresh all dashboard data.
 * Main data loading function for the application.
 */
export async function refreshData(): Promise<void> {
  showLoading('Loading data...');
  try {
    // Build URL with view filter
    const currentViewId = store.get('currentViewId');
    let url = '/api/dashboard/data';
    if (currentViewId) {
      url += `?view_id=${currentViewId}`;
    }

    const data = await apiCall<DashboardData>(url);

    // Store positions and accounts first: the renderers and the holdings
    // account filter read them.
    store.set('currentPositions', data.positions);
    store.set('accounts', data.summary.accounts || []);

    updateHoldings(data.positions);
    updateAccountFilter(data.positions);
    await renderDashboard(data);

    // Update demo mode UI from response. NOTE: in local (hosted) mode the
    // composite's demo_mode mirrors the server state fetched at boot
    // (checkDemoModeStatus -> store), not a hardcoded false — the server's
    // demo flag is global and the banner must agree with it.
    if (data.demo_mode !== undefined) {
      store.set('demoMode', data.demo_mode);
      updateDemoModeUI(data.demo_mode);
    }

    // Auto-load dashboard widgets
    await loadWidgets();

    // Re-initialize AI commentary buttons after data loads
    // This is called from main.ts after import
    const event = new CustomEvent('dashboard:dataLoaded');
    document.dispatchEvent(event);
    // Mirror onto the typed bus. Dashboard re-renders are downstream of
    // position changes; the existing string event keeps firing alongside for
    // legacy listeners.
    emit({ type: 'commentary:invalidated' });
  } catch (error) {
    console.error('Error loading data:', error);
    showToast('Failed to load portfolio data', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Check for duplicate positions across accounts.
 *
 * @returns number of duplicate groups found (0 when none or on error)
 */
export async function checkForDuplicates(): Promise<number> {
  try {
    const data = await apiCall<DuplicatesResponse>('/api/portfolio/duplicates');

    duplicatesData = data.duplicates || [];
    store.set(
      'duplicates',
      duplicatesData.map((d) => ({
        ticker: d.ticker,
        positions: d.positions.map((p) => ({
          id: p.id,
          ticker: d.ticker,
          name: '',
          shares: d.shares,
          price: null,
          value: p.value,
          cost_basis: null,
          account: p.account_name,
          account_type: '',
          is_fund: false,
          position_type: 'equity' as const,
        })),
        total_shares: d.shares,
        total_value: d.positions.reduce((sum, p) => sum + p.value, 0),
      }))
    );

    return data.has_duplicates ? data.count : 0;
  } catch (error) {
    console.error('Error checking for duplicates:', error);
    showToast('Unable to check for duplicate positions', 'warning');
    return 0;
  }
}

/**
 * Show duplicate position details in a modal.
 */
export function showDuplicateDetails(): void {
  if (duplicatesData.length === 0) {
    showToast('No duplicate details available', 'info');
    return;
  }

  // Build content using safe DOM methods
  const container = document.createElement('div');
  container.className = 'duplicate-list';

  duplicatesData.forEach((dup) => {
    const item = document.createElement('div');
    item.className = 'duplicate-item';

    const header = document.createElement('h4');
    header.textContent = `${dup.ticker} - ${dup.shares.toFixed(6)} shares`;
    item.appendChild(header);

    const reason = document.createElement('p');
    reason.textContent = dup.reason;
    item.appendChild(reason);

    const positions = document.createElement('div');
    positions.className = 'positions';

    dup.positions.forEach((pos) => {
      const chip = document.createElement('div');
      chip.className = 'position-chip';

      const account = document.createElement('span');
      account.className = 'account';
      account.textContent = pos.account_name;
      chip.appendChild(account);

      const value = document.createElement('span');
      value.textContent = formatCurrency(pos.value);
      chip.appendChild(value);

      const deleteBtn = document.createElement('span');
      deleteBtn.className = 'delete-btn';
      deleteBtn.title = 'Delete this position';
      deleteBtn.appendChild(createDeleteIcon());
      deleteBtn.addEventListener('click', () => deleteDuplicatePosition(pos.id));
      chip.appendChild(deleteBtn);

      positions.appendChild(chip);
    });

    item.appendChild(positions);
    container.appendChild(item);
  });

  const note = document.createElement('p');
  note.style.marginTop = '16px';
  note.style.fontSize = '12px';
  note.style.color = 'var(--color-text-tertiary)';
  note.textContent =
    'Click the delete icon next to a position to remove it. Usually you want to keep one and remove the duplicate.';
  container.appendChild(note);

  createDynamicModal({
    title: 'Potential Duplicates',
    content: container,
    showFooter: false,
  });
}

/**
 * Delete a duplicate position.
 */
export function deleteDuplicatePosition(positionId: string): void {
  showConfirmDialog(
    'Are you sure you want to delete this position?',
    async () => {
      try {
        await apiCall(`/api/portfolio/positions/${positionId}`, { method: 'DELETE' });
        showToast('Position deleted', 'success');
        closeModal();
        await refreshData();
      } catch (error) {
        console.error('Error deleting position:', error);
        showToast('Error deleting position', 'error');
      }
    },
    { title: 'Delete Position', confirmText: 'Delete', isDangerous: true }
  );
}

// ---------------------------------------------------------------------------
// Overview dashboard rendering
// ---------------------------------------------------------------------------

/** True once the range buttons have been set from the loaded history (or by the user). */
let historyRangeInitialized = false;

/**
 * Bumped by every card render; a self-fetching card that resolves after a
 * newer render started discards its result.
 */
let renderGeneration = 0;

/** True once renderDashboard has run, so tab-show refreshes have data to use. */
let dashboardRendered = false;

/** Test-only: reset module-level render state. */
export function resetDashboardRenderState(): void {
  historyRangeInitialized = false;
  renderGeneration = 0;
  dashboardRendered = false;
}

/** Subset of GET /api/portfolio/dashboard-metrics the On track card reads. */
interface OnTrackMetrics {
  success_probability: number | null;
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

function signedCurrency(amount: number): string {
  return `${amount < 0 ? '-' : '+'}${formatCurrency(Math.abs(amount))}`;
}

function signedPercent(pct: number): string {
  return `${pct < 0 ? '-' : '+'}${Math.abs(pct).toFixed(2)}%`;
}

/** "+$1,234.56 (+0.23%)" for a change, percent omitted when unknown. */
function describeChange(change: Change): string {
  const amount = signedCurrency(change.amount);
  return change.pct === null ? amount : `${amount} (${signedPercent(change.pct)})`;
}

/** Write a change into a hero span, or empty and hide it when unknown. */
function setChange(id: string, change: Change | null, suffix: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (!change) {
    el.textContent = '';
    el.hidden = true;
    el.classList.remove('positive', 'negative');
    return;
  }
  el.hidden = false;
  el.textContent = `${describeChange(change)} ${suffix}`;
  el.classList.remove('positive', 'negative');
  el.classList.add(change.amount < 0 ? 'negative' : 'positive');
}

function rangeSuffix(key: RangeKey): string {
  if (key === 'YTD') return 'year to date';
  if (key === 'ALL') return 'over all time';
  return `over ${key}`;
}

/** Update #range-change for a filtered history and the range it was filtered for. */
function renderRangeChange(filtered: SnapshotHistory[], key: RangeKey): void {
  setChange('range-change', historyChange(filtered), rangeSuffix(key));
}

function renderHero(data: DashboardData): void {
  const totalEl = document.getElementById('total-value');
  if (totalEl) totalEl.textContent = formatCurrency(data.summary.total_value);

  setChange('day-change', portfolioDayChange(data.positions, data.summary.total_value), 'today');

  const gainEl = document.getElementById('total-gain');
  if (gainEl) {
    const gain = data.summary.total_gain_loss;
    if (gain === null || gain === undefined) {
      gainEl.textContent = '';
      gainEl.hidden = true;
    } else {
      gainEl.hidden = false;
      gainEl.textContent =
        gain < 0
          ? `Total loss ${formatCurrency(Math.abs(gain))}`
          : `Total gain ${signedCurrency(gain)}`;
    }
  }
}

function openSettings(event: Event): void {
  event.preventDefault();
  showTab('settings');
}

function settingsLink(text: string, action = 'open-settings'): HTMLAnchorElement {
  const link = h('a', undefined, text);
  link.href = '#';
  link.dataset.action = action;
  link.addEventListener('click', openSettings);
  return link;
}

async function fetchAssetClassTargets(): Promise<Record<string, unknown> | null> {
  try {
    const config = await apiCall<{ targets?: { asset_class?: Record<string, unknown> } }>(
      '/api/settings/config'
    );
    return config.targets?.asset_class ?? null;
  } catch (error) {
    console.error('Error loading allocation targets:', error);
    return null;
  }
}

async function renderAllocation(positions: DashboardPosition[], gen: number): Promise<void> {
  const host = document.getElementById('allocation-bars');
  if (!host) return;
  const targets = await fetchAssetClassTargets();
  if (gen !== renderGeneration) return;
  const rows = allocationVsTarget(positions, targets);
  host.textContent = '';

  if (rows.length === 0) {
    host.appendChild(h('p', 'alloc-empty', 'No holdings yet.'));
    return;
  }

  for (const row of rows) {
    const wrap = h('div', 'alloc-row');
    const head = h('div', 'alloc-row-head');
    head.appendChild(h('span', 'alloc-label', row.label));
    const figures =
      row.targetPct === null
        ? `${row.actualPct.toFixed(1)}%`
        : `${row.actualPct.toFixed(1)}% (target ${row.targetPct.toFixed(0)}%)`;
    head.appendChild(h('span', 'alloc-figures', figures));
    wrap.appendChild(head);

    const track = h('div', 'alloc-track');
    const fill = h('div', 'alloc-fill');
    fill.style.width = `${Math.min(100, row.actualPct)}%`;
    track.appendChild(fill);
    if (row.targetPct !== null) {
      const marker = h('div', 'alloc-target');
      marker.style.left = `${Math.min(100, row.targetPct)}%`;
      track.appendChild(marker);
    }
    wrap.appendChild(track);

    if (row.outOfBand && row.driftPct !== null) {
      const direction = row.driftPct > 0 ? 'over' : 'under';
      wrap.appendChild(
        h('div', 'alloc-drift', `${Math.abs(row.driftPct).toFixed(1)} points ${direction} target`)
      );
    }
    host.appendChild(wrap);
  }

  if (!hasTargets(targets)) {
    const note = h('p', 'alloc-empty', 'No targets set. ');
    note.appendChild(settingsLink('Set targets'));
    host.appendChild(note);
  }
}

/** Show Projections and submit its Monte Carlo form (only on a user click). */
function runQuickCheck(): void {
  showTab('projections');
  const form = document.getElementById('projection-form') as HTMLFormElement | null;
  form?.requestSubmit();
}

async function renderOnTrack(gen: number): Promise<void> {
  const host = document.getElementById('on-track-body');
  if (!host) return;

  const entityId = store.get('currentEntityId');
  const metricsUrl = entityId
    ? `/api/portfolio/dashboard-metrics?entity_id=${encodeURIComponent(entityId)}`
    : '/api/portfolio/dashboard-metrics';
  const [personalResult, metricsResult] = await Promise.allSettled([
    apiCall<{ personal?: { dob?: string | null }; dob?: string | null }>(
      '/api/settings/config/personal'
    ),
    apiCall<OnTrackMetrics>(metricsUrl),
  ]);
  if (gen !== renderGeneration) return;

  let dob: string | null = null;
  let metrics: OnTrackMetrics | null = null;
  if (personalResult.status === 'fulfilled') {
    dob = personalResult.value.personal?.dob ?? personalResult.value.dob ?? null;
  } else {
    console.error('Error loading personal settings for on-track card:', personalResult.reason);
  }
  if (metricsResult.status === 'fulfilled') {
    metrics = metricsResult.value;
  } else {
    console.error('Error loading metrics for on-track card:', metricsResult.reason);
  }

  host.textContent = '';

  if (personalResult.status === 'rejected' && metricsResult.status === 'rejected') {
    host.appendChild(h('p', 'on-track-note', 'On-track status is unavailable right now.'));
    return;
  }

  if (personalResult.status === 'fulfilled' && !dob) {
    const note = h('p', 'on-track-note', "Add your birth date to see if you're on track. ");
    note.appendChild(settingsLink('Open Settings'));
    host.appendChild(note);
    return;
  }

  const probability = metrics?.success_probability;
  if (probability === null || probability === undefined) {
    host.appendChild(h('p', 'on-track-note', 'No simulation yet.'));
    const run = h('button', 'btn btn-secondary btn-sm', 'Run a quick check');
    run.type = 'button';
    run.addEventListener('click', runQuickCheck);
    host.appendChild(run);
    return;
  }

  const rounded = Math.round(probability);
  host.appendChild(h('div', 'on-track-figure', `${rounded}%`));
  const status = h('div', 'on-track-status');
  if (rounded >= 80) {
    status.textContent = 'On track';
    status.classList.add('positive');
  } else if (rounded >= 50) {
    status.textContent = 'Worth a look';
  } else {
    status.textContent = 'At risk';
    status.classList.add('negative');
  }
  host.appendChild(status);
  host.appendChild(h('p', 'on-track-note', 'chance your money lasts, from your last simulation'));
  const link = h('a', undefined, 'See projections');
  link.href = '#';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showTab('projections');
  });
  host.appendChild(link);
}

const ATTENTION_ACTIONS: Record<AttentionItem['action'], { label: string; run: () => void }> = {
  'refresh-prices': {
    label: 'Refresh',
    run: () => {
      refreshPrices(true).catch(console.error);
    },
  },
  'show-duplicates': { label: 'Review', run: () => showDuplicateDetails() },
  'open-holdings': { label: 'View holdings', run: () => showTab('holdings') },
  'open-analysis': { label: 'View alerts', run: () => showTab('analysis') },
};

async function renderAttention(positions: DashboardPosition[], gen: number): Promise<void> {
  const list = document.getElementById('attention-list');
  if (!list) return;

  const [status, duplicateCount, alerts] = await Promise.all([
    apiCall<PriceStatusResponse>('/api/imports/price-status').catch((error: unknown) => {
      console.error('Error loading price status for attention list:', error);
      return null;
    }),
    checkForDuplicates(),
    apiCall<TriggeredAlert[]>('/api/analysis/triggers/triggered').catch((error: unknown) => {
      console.error('Error loading triggered alerts:', error);
      return [] as TriggeredAlert[];
    }),
  ]);

  if (gen !== renderGeneration) return;

  // Markets closed means prices are as current as they can be (see updatePriceStatus).
  const staleTickers = status && status.market_open !== false ? status.stale_tickers : 0;
  const items = attentionItems({
    staleTickers,
    positions,
    duplicateCount,
    triggeredAlerts: Array.isArray(alerts) ? alerts : [],
    today: new Date(),
  });

  list.textContent = '';
  if (items.length === 0) {
    list.appendChild(h('li', 'attention-clear', 'All clear'));
    return;
  }
  for (const item of items) {
    const li = h('li');
    li.appendChild(h('span', 'attention-message', item.message));
    const action = ATTENTION_ACTIONS[item.action];
    const btn = h('button', 'btn btn-secondary btn-sm', action.label);
    btn.type = 'button';
    btn.addEventListener('click', action.run);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/** Show Holdings filtered to a single account. */
function showHoldingsForAccount(name: string): void {
  store.set('selectedAccounts', new Set([name]));
  const boxes = document.querySelectorAll<HTMLInputElement>(
    '#account-filter-options input[type="checkbox"]'
  );
  if (boxes.length > 0) {
    boxes.forEach((cb) => {
      cb.checked = cb.value === name;
    });
    handleAccountFilterChange();
  } else {
    updateAccountFilterLabel();
    document.dispatchEvent(new CustomEvent('accountFilter:changed'));
  }
  showTab('holdings');
}

function renderAccounts(data: DashboardData): void {
  const host = document.getElementById('account-groups');
  if (!host) return;
  host.textContent = '';

  const groups = groupAccounts(
    data.summary.accounts || [],
    data.positions,
    data.summary.total_value
  );
  if (groups.length === 0) {
    host.appendChild(
      h('p', 'alloc-empty', 'No accounts yet. Add your first account from the Holdings tab.')
    );
    return;
  }

  for (const group of groups) {
    const section = h('div', 'account-group');
    const head = h('div', 'account-group-head');
    head.appendChild(h('span', undefined, group.label));
    head.appendChild(h('span', undefined, formatCurrency(group.subtotal)));
    section.appendChild(head);

    for (const row of group.rows) {
      const btn = h('button', 'account-row');
      btn.type = 'button';
      btn.appendChild(h('span', 'account-row-name', row.name));
      btn.appendChild(h('span', 'account-row-value', formatCurrency(row.value)));
      const meta = `${row.pctOfTotal.toFixed(1)}%${
        row.dayChange === null ? '' : ` · ${signedCurrency(row.dayChange)} today`
      }`;
      btn.appendChild(h('span', 'account-row-meta', meta));
      btn.addEventListener('click', () => showHoldingsForAccount(row.name));
      section.appendChild(btn);
    }
    host.appendChild(section);
  }
}

/**
 * Render the overview dashboard from one dashboard payload: hero figures,
 * history chart, allocation vs target, on-track card, attention list and
 * grouped accounts. All data is written with textContent.
 */
export async function renderDashboard(data: DashboardData): Promise<void> {
  const history = data.history ?? [];

  if (!historyRangeInitialized && history.length >= 2) {
    applyHistoryRange(defaultRange(history));
    historyRangeInitialized = true;
  }

  renderHero(data);
  renderAccounts(data);
  await updateHistoryChart(history, true, renderRangeChange);

  dashboardRendered = true;
  await renderCards(data.positions);
}

/**
 * Render the three cards that load their own data (allocation, on track,
 * attention). Called on every dashboard render and whenever the Dashboard tab
 * is shown, so changes made in Settings or Projections show up on return.
 */
export async function renderCards(positions: DashboardPosition[]): Promise<void> {
  const gen = ++renderGeneration;
  await Promise.all([
    renderAllocation(positions, gen),
    renderOnTrack(gen),
    renderAttention(positions, gen),
  ]);
}

/** Wire the history range buttons. */
function initRangeButtons(): void {
  applyHistoryRange(store.get('currentHistoryRange'));
  document.querySelectorAll<HTMLElement>('.time-range-btn[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-range') as RangeKey | null;
      if (!key) return;
      historyRangeInitialized = true;
      setHistoryRange(key, renderRangeChange).catch(console.error);
    });
  });
}

/**
 * Update account filter dropdown options.
 * Called by holdings page but initialized from dashboard data.
 */
export function updateAccountFilter(positions: DashboardPosition[]): void {
  const accounts = [...new Set(positions.map((p) => p.account))].sort();
  const optionsContainer = document.getElementById('account-filter-options');
  if (!optionsContainer) return;

  // Preserve current selection
  const selectedAccounts = store.get('selectedAccounts');
  const currentSelection = new Set(selectedAccounts);

  // Clear and rebuild options safely
  optionsContainer.textContent = '';

  accounts.forEach((acc) => {
    const option = document.createElement('div');
    option.className = 'multi-select-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `acc-${acc.replace(/\s+/g, '-')}`;
    checkbox.value = acc;
    checkbox.checked = currentSelection.size === 0 || currentSelection.has(acc);
    checkbox.addEventListener('change', handleAccountFilterChange);
    option.appendChild(checkbox);

    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = acc;
    option.appendChild(label);

    optionsContainer.appendChild(option);
  });

  // Initialize selectedAccounts if empty
  if (currentSelection.size === 0) {
    store.set('selectedAccounts', new Set(accounts));
  }

  // Render the trigger label for the current selection.
  updateAccountFilterLabel();
}

/**
 * Handle account filter checkbox changes.
 */
function handleAccountFilterChange(): void {
  const checkedBoxes = document.querySelectorAll(
    '#account-filter-options input[type="checkbox"]:checked'
  );
  const selected = new Set<string>();
  checkedBoxes.forEach((cb) => {
    selected.add((cb as HTMLInputElement).value);
  });
  store.set('selectedAccounts', selected);

  // Update the trigger button label so the user sees what's selected.
  updateAccountFilterLabel();

  // Trigger holdings update
  const event = new CustomEvent('accountFilter:changed');
  document.dispatchEvent(event);
}

/**
 * Refresh the account filter dropdown options from the current positions
 * snapshot. Wired as a subscriber to `accounts:changed` so a newly-created
 * account shows up in the filter without a page reload.
 *
 * NOTE: `updateAccountFilter` derives accounts from the positions array, so
 * an account with zero positions still won't appear here — the right path
 * for that is a full `refreshData()` which re-fetches both. We do that in the
 * main subscriber (see initDashboard) and call this directly only for
 * cases where positions are already up to date.
 */
function refreshAccountFilterFromState(): void {
  const positions = store.get('currentPositions');
  if (positions.length > 0) {
    updateAccountFilter(positions);
  }
}

/**
 * Refresh prices from external APIs.
 */
export async function refreshPrices(force = false): Promise<void> {
  showLoading('Refreshing prices from APIs...');
  try {
    const url = force ? '/api/imports/refresh-prices?force=true' : '/api/imports/refresh-prices';
    const result = await apiCall<PriceRefreshResponse>(url, { method: 'POST' });

    // Update the badge first so the "X stale" indicator reflects the new
    // truth even if the broader dashboard refresh below fails. Without this
    // ordering, a failure in refreshData() left the badge showing the old
    // stale count, which is the bug reported by the user.
    await updatePriceStatus();

    // Honest user feedback based on actual server-reported counts.
    const attempted = result.attempted ?? result.updated ?? 0;
    const failedCount = result.failed ?? 0;
    if (result.all_fresh && result.updated === 0) {
      showToast(result.message ?? 'Prices are fresh', 'info');
    } else if (failedCount > 0) {
      const sample = (result.failed_tickers ?? []).slice(0, 3).join(', ');
      const more = (result.failed_tickers ?? []).length > 3 ? '…' : '';
      showToast(
        `Updated ${result.updated} of ${attempted}; ${failedCount} failed${sample ? ` (${sample}${more})` : ''}`,
        'warning'
      );
    } else {
      showToast(`Prices updated: ${result.updated} tickers`, 'success');
    }

    // Refresh the rest of the dashboard (positions, charts, history) last.
    await refreshData();

    // Notify subscribers with actual server-reported counts. This is the
    // event that closes the bug class behind 55eb50c — dependents that need
    // to react to prices having moved (badges, charts, AI commentary cache)
    // now have a single, type-checked hook.
    emit({
      type: 'prices:refreshed',
      updated: result.updated ?? 0,
      failed: failedCount,
    });
  } catch (error) {
    console.error('Error refreshing prices:', error);
    showToast('Failed to refresh prices', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Update price status indicator.
 */
export async function updatePriceStatus(): Promise<void> {
  try {
    const status = await apiCall<PriceStatusResponse>('/api/imports/price-status');

    const statusEl = document.getElementById('price-status');
    if (!statusEl) return;

    if (status.market_open === false) {
      // Markets closed: prices are as current as they can be (last close).
      statusEl.className = 'price-status fresh';
      statusEl.textContent = '';

      const dot = document.createElement('span');
      dot.className = 'status-dot';
      statusEl.appendChild(dot);

      const asOf = status.newest_update
        ? new Date(status.newest_update).toLocaleString()
        : 'last close';
      statusEl.appendChild(document.createTextNode(` Markets closed (prices as of ${asOf})`));
      statusEl.title = 'Market closed: prices current as of last close';
      return;
    }

    if (status.all_fresh) {
      const newestUpdate = status.newest_update ? new Date(status.newest_update) : null;
      const hoursAgo = newestUpdate
        ? Math.round((Date.now() - newestUpdate.getTime()) / (1000 * 60 * 60))
        : null;

      statusEl.className = 'price-status fresh';
      statusEl.textContent = '';

      const dot = document.createElement('span');
      dot.className = 'status-dot';
      statusEl.appendChild(dot);

      const text = document.createTextNode(
        ` Prices fresh${hoursAgo !== null ? ` (${hoursAgo}h ago)` : ''}`
      );
      statusEl.appendChild(text);

      statusEl.title = 'All prices updated within 24 hours';
    } else if (status.stale_tickers > 0) {
      statusEl.className = 'price-status stale';
      statusEl.textContent = '';

      const dot = document.createElement('span');
      dot.className = 'status-dot';
      statusEl.appendChild(dot);

      const text = document.createTextNode(` ${status.stale_tickers} stale`);
      statusEl.appendChild(text);

      statusEl.title = `${status.stale_tickers} ticker(s) need price updates`;
    } else {
      statusEl.className = 'price-status';
      statusEl.textContent = '';
    }
  } catch (error) {
    console.error('Error loading price status:', error);
    // Set status to unknown state so users know the check failed
    const statusEl = document.getElementById('price-status');
    if (statusEl) {
      statusEl.className = 'price-status';
      statusEl.textContent = '';
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      statusEl.appendChild(dot);
      statusEl.appendChild(document.createTextNode(' Status unavailable'));
      statusEl.title = 'Unable to check price freshness';
    }
  }
}

/**
 * Placeholder for updateHoldings - defined in holdings.ts
 * This function is imported/called but defined elsewhere.
 */
function updateHoldings(positions: DashboardPosition[]): void {
  // Dispatch event for holdings page to handle. The legacy string event
  // carries the positions array as `detail` — keep it in place; the typed
  // bus is additive and intentionally does not duplicate that payload here
  // (positions are already in the store when this fires).
  const event = new CustomEvent('dashboard:positionsUpdated', { detail: positions });
  document.dispatchEvent(event);
}

/**
 * Initialize dashboard event handlers.
 */
export function initDashboard(): void {
  // Price refresh button — guard against double-click. The endpoint is
  // idempotent server-side but the UX feedback was inconsistent.
  const refreshPricesBtn = document.getElementById(
    'refresh-prices-btn'
  ) as HTMLButtonElement | null;
  if (refreshPricesBtn) {
    refreshPricesBtn.addEventListener('click', () => {
      withSubmitGuard(refreshPricesBtn, 'Refreshing...', () => refreshPrices(false)).catch(
        console.error
      );
    });
  }

  // Force refresh button (HTML id: update-prices-btn). Same guard.
  const forceRefreshBtn = (document.getElementById('force-refresh-btn') ??
    document.getElementById('update-prices-btn')) as HTMLButtonElement | null;
  if (forceRefreshBtn) {
    forceRefreshBtn.addEventListener('click', () => {
      withSubmitGuard(forceRefreshBtn, 'Updating...', () => refreshPrices(true)).catch(
        console.error
      );
    });
  }

  initRangeButtons();

  // Re-render the self-fetching cards from the positions already in the store
  // when the Dashboard tab becomes visible (no dashboard refetch, no chart).
  onTabChange((tab) => {
    if (tab === 'dashboard' && dashboardRendered) {
      renderCards(store.get('currentPositions')).catch(console.error);
    }
  });

  // Initial price status update
  updatePriceStatus();

  // --- Typed bus subscribers ------------------------------------------------
  // These close real bugs where a mutation happened but the dependent view
  // didn't auto-refresh. Each is intentionally narrow to avoid double-fetch.

  // 1. Account filter dropdown should refresh when accounts change so a
  //    newly-created account appears in the filter without a page reload.
  //    We re-derive from the positions snapshot when possible; for 'added'
  //    a full refresh is needed because new accounts have zero positions.
  on('accounts:changed', (event) => {
    if (event.reason === 'added') {
      // New account has no positions yet — refetch to surface it.
      refreshData().catch(console.error);
    } else {
      refreshAccountFilterFromState();
    }
  });

  // 2. Plugin widget grid should reload when a plugin is installed/enabled/
  //    disabled. `loadWidgets` has its own concurrency mutex so back-to-back
  //    fires are safe.
  on('plugin:changed', () => {
    loadWidgets().catch(console.error);
  });
}

/**
 * Auto-refresh prices if any are stale (older than 24 hours).
 * Uses the user's browser timezone for accurate staleness detection.
 * Only refreshes stale tickers to conserve API rate limits.
 */
export async function autoRefreshIfStale(): Promise<void> {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const status = await apiCall<PriceStatusResponse>(
      `/api/imports/price-status?timezone=${encodeURIComponent(tz)}`
    );

    // Markets closed: nothing to fetch; prices are current as of last close.
    if (status.market_open === false) return;
    if (status.all_fresh && status.stale_tickers === 0) return;

    const result = await apiCall<PriceRefreshResponse>('/api/imports/refresh-prices', {
      method: 'POST',
    });
    if (result.updated === 0) {
      // Gated no-op (hourly cap or nothing due): the badge already shows
      // the state, so stay silent.
      return;
    }

    showToast(`Auto-updated ${result.updated} price(s)`, 'info');
    await updatePriceStatus();
    await refreshData();
    emit({
      type: 'prices:refreshed',
      updated: result.updated,
      failed: result.failed ?? 0,
    });
  } catch (error) {
    console.warn('Auto-refresh price check failed:', error);
  }
}

// Alias for compatibility
export const loadData = refreshData;
