/**
 * Dashboard page module.
 * Handles main data loading, summary updates, and dashboard widgets.
 */

import { apiCall } from '@/api/client';
import { store } from '@/state/store';
import { showLoading, hideLoading } from '@/ui/loading';
import { showToast } from '@/ui/toast';
import { closeModal, showConfirmDialog, createDynamicModal } from '@/ui/modal';
import { formatCurrency, formatNumber } from '@/utils/format';
import { updateAllocationCharts, updateHistoryChart } from '@/charts/allocation';
import { loadWidgets } from '@/features/plugins';
import type {
  DashboardData,
  DashboardPosition,
  PortfolioSummary,
  AccountResponse,
} from '@/types/api';

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
}

/**
 * Price refresh response from API.
 */
interface PriceRefreshResponse {
  all_fresh: boolean;
  updated: number;
}

/**
 * Dashboard metrics response from API.
 */
interface DashboardMetrics {
  monthly_retirement_income: number | null;
  withdrawal_rate: number | null;
  success_probability: number | null;
  earliest_retirement_age: number | null;
  fire_number: number | null;
  target_monthly_income: number | null;
  target_retirement_age: number | null;
  simulation_required: boolean;
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

    // Update UI components
    updateSummary(data.summary);
    updateHoldings(data.positions);
    await updateAllocationCharts(data.positions, data.summary);
    await updateHistoryChart(data.history);
    updateAccountFilter(data.positions);

    // Store positions in state
    store.set('currentPositions', data.positions);
    store.set('accounts', data.summary.accounts || []);

    // Update account totals table
    updateAccountTotalsTable(data.summary.accounts || []);

    // Update demo mode UI from response
    if (data.demo_mode !== undefined) {
      store.set('demoMode', data.demo_mode);
      updateDemoModeUI(data.demo_mode);
    }

    // Check for duplicate positions
    await checkForDuplicates();

    // Load retirement metrics for dashboard
    await loadRetirementMetrics();

    // Auto-load dashboard widgets
    await loadWidgets();

    // Re-initialize AI commentary buttons after data loads
    // This is called from main.ts after import
    const event = new CustomEvent('dashboard:dataLoaded');
    document.dispatchEvent(event);
  } catch (error) {
    console.error('Error loading data:', error);
    showToast('Failed to load portfolio data', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Load retirement metrics for dashboard row 2.
 * If an entity is selected, loads metrics filtered to that entity.
 *
 * @returns true if metrics loaded successfully, false on error
 */
export async function loadRetirementMetrics(): Promise<boolean> {
  try {
    // Build URL with entity filter if one is selected
    const currentEntityId = store.get('currentEntityId');
    let url = '/api/portfolio/dashboard-metrics';
    if (currentEntityId) {
      url += `?entity_id=${encodeURIComponent(currentEntityId)}`;
    }

    const metrics = await apiCall<DashboardMetrics>(url);

    // Update Monthly Retirement Income
    const monthlyIncomeEl = document.getElementById('monthly-retirement-income');
    const withdrawalLabel = document.getElementById('withdrawal-rate-label');
    if (monthlyIncomeEl) {
      if (metrics.monthly_retirement_income !== null) {
        monthlyIncomeEl.textContent = formatCurrency(metrics.monthly_retirement_income);
        if (withdrawalLabel) {
          withdrawalLabel.textContent = `at ${metrics.withdrawal_rate}% of projected portfolio`;
        }
      } else {
        monthlyIncomeEl.textContent = '--';
        if (withdrawalLabel) {
          withdrawalLabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update Success Probability
    const successProbEl = document.getElementById('success-probability');
    const successSublabel = document.getElementById('success-sublabel');
    if (successProbEl) {
      if (metrics.success_probability !== null) {
        successProbEl.textContent = `${metrics.success_probability}%`;
        successProbEl.classList.remove('positive', 'negative');
        if (metrics.success_probability >= 80) {
          successProbEl.classList.add('positive');
        } else if (metrics.success_probability < 50) {
          successProbEl.classList.add('negative');
        }
        if (successSublabel) {
          successSublabel.textContent = 'of not running out by age 90';
        }
      } else {
        successProbEl.textContent = '--';
        successProbEl.classList.remove('positive', 'negative');
        if (successSublabel) {
          successSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update Earliest Retirement Age
    const retireAgeEl = document.getElementById('earliest-retirement-age');
    const retireSublabel = document.getElementById('retire-sublabel');
    if (retireAgeEl) {
      if (metrics.earliest_retirement_age != null) {
        retireAgeEl.textContent = `Age ${metrics.earliest_retirement_age}`;
        if (retireSublabel) {
          retireSublabel.textContent = 'with 80%+ success rate';
        }
      } else {
        retireAgeEl.textContent = '--';
        if (retireSublabel) {
          retireSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }

    // Update FIRE Number
    const fireNumberEl = document.getElementById('fire-number');
    const fireSublabel = document.getElementById('fire-sublabel');
    if (fireNumberEl) {
      if (metrics.fire_number !== null) {
        fireNumberEl.textContent = formatCurrency(metrics.fire_number);
        if (fireSublabel) {
          if (metrics.target_monthly_income) {
            fireSublabel.textContent = `for $${formatNumber(metrics.target_monthly_income, 0)}/mo target`;
          } else {
            fireSublabel.textContent = `projected at age ${metrics.target_retirement_age}`;
          }
        }
      } else {
        fireNumberEl.textContent = '--';
        if (fireSublabel) {
          fireSublabel.textContent = 'Run Monte Carlo simulation';
        }
      }
    }
    return true;
  } catch (error) {
    console.error('Error loading retirement metrics:', error);
    showToast('Unable to load retirement metrics', 'error');
    return false;
  }
}

/**
 * Update summary stat cards.
 */
export function updateSummary(summary: PortfolioSummary): void {
  const totalEl = document.getElementById('total-value');
  if (totalEl) {
    totalEl.textContent = formatCurrency(summary.total_value);
  }

  const gainLoss = summary.total_gain_loss;
  const gainLossEl = document.getElementById('gain-loss');
  if (gainLossEl) {
    gainLossEl.textContent = formatCurrency(gainLoss);
    gainLossEl.className = 'stat-value ' + (gainLoss && gainLoss >= 0 ? 'positive' : 'negative');
  }

  const retirementEl = document.getElementById('retirement-value');
  if (retirementEl) {
    retirementEl.textContent = formatCurrency(summary.retirement_value);
  }

  const taxableEl = document.getElementById('taxable-value');
  if (taxableEl) {
    taxableEl.textContent = formatCurrency(summary.taxable_value);
  }
}

/**
 * Check for duplicate positions across accounts.
 */
export async function checkForDuplicates(): Promise<void> {
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

    const warningEl = document.getElementById('duplicate-warning');
    const messageEl = document.getElementById('duplicate-message');

    if (data.has_duplicates && warningEl) {
      warningEl.style.display = 'flex';
      const count = data.count;
      if (messageEl) {
        messageEl.textContent = `Found ${count} position${
          count > 1 ? 's' : ''
        } with identical tickers and quantities across different accounts. This may indicate duplicate entries.`;
      }
    } else if (warningEl) {
      warningEl.style.display = 'none';
    }
  } catch (error) {
    console.error('Error checking for duplicates:', error);
    // Inform user and hide warning since we can't verify status
    showToast('Unable to check for duplicate positions', 'warning');
    const warningEl = document.getElementById('duplicate-warning');
    if (warningEl) {
      warningEl.style.display = 'none';
    }
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
export async function deleteDuplicatePosition(positionId: string): Promise<void> {
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

/**
 * Update account totals table on dashboard.
 */
export function updateAccountTotalsTable(accounts: AccountResponse[]): void {
  const tbody = document.getElementById('account-totals-body');
  const sumEl = document.getElementById('account-totals-sum');

  if (!tbody || !accounts || accounts.length === 0) {
    if (tbody) {
      tbody.textContent = '';
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'text-center';
      cell.textContent = 'No accounts';
      row.appendChild(cell);
      tbody.appendChild(row);
    }
    return;
  }

  // Sort by value descending
  const sortedAccounts = [...accounts].sort((a, b) => b.value - a.value);
  const total = sortedAccounts.reduce((sum, acc) => sum + acc.value, 0);

  // Clear and rebuild table body safely
  tbody.textContent = '';

  sortedAccounts.forEach((acc) => {
    const pct = total > 0 ? (acc.value / total) * 100 : 0;
    const typeClass = acc.is_retirement ? 'type-retirement' : 'type-taxable';

    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = acc.name;
    nameCell.appendChild(strong);
    row.appendChild(nameCell);

    const typeCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `account-type-badge ${typeClass}`;
    badge.textContent = acc.display_type;
    typeCell.appendChild(badge);
    row.appendChild(typeCell);

    const valueCell = document.createElement('td');
    valueCell.className = 'text-right';
    valueCell.textContent = formatCurrency(acc.value);
    row.appendChild(valueCell);

    const pctCell = document.createElement('td');
    pctCell.className = 'text-right';
    pctCell.textContent = `${pct.toFixed(1)}%`;
    row.appendChild(pctCell);

    tbody.appendChild(row);
  });

  if (sumEl) {
    sumEl.textContent = formatCurrency(total);
  }
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

  // Trigger holdings update
  const event = new CustomEvent('accountFilter:changed');
  document.dispatchEvent(event);
}

/**
 * Refresh prices from external APIs.
 */
export async function refreshPrices(force = false): Promise<void> {
  showLoading('Refreshing prices from APIs...');
  try {
    const url = force ? '/api/imports/refresh-prices?force=true' : '/api/imports/refresh-prices';
    const result = await apiCall<PriceRefreshResponse>(url, { method: 'POST' });

    // Reload data
    await refreshData();

    if (result.all_fresh && result.updated === 0) {
      showToast('Prices are fresh (less than 24 hours old)', 'info');
    } else {
      showToast(`Prices updated: ${result.updated || 0} tickers`, 'success');
    }

    // Update price status display
    await updatePriceStatus();
  } catch (error) {
    console.error('Error refreshing prices:', error);
    showToast('Failed to refresh prices', 'error');
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
 * Update demo mode UI state.
 */
function updateDemoModeUI(isDemoMode: boolean): void {
  const indicator = document.getElementById('demo-mode-indicator');
  if (indicator) {
    indicator.style.display = isDemoMode ? 'flex' : 'none';
  }

  const toggle = document.getElementById('demo-mode-toggle') as HTMLInputElement | null;
  if (toggle) {
    toggle.checked = isDemoMode;
  }
}

/**
 * Placeholder for updateHoldings - defined in holdings.ts
 * This function is imported/called but defined elsewhere.
 */
function updateHoldings(positions: DashboardPosition[]): void {
  // Dispatch event for holdings page to handle
  const event = new CustomEvent('dashboard:positionsUpdated', { detail: positions });
  document.dispatchEvent(event);
}

/**
 * Initialize dashboard event handlers.
 */
export function initDashboard(): void {
  // Price refresh button
  const refreshPricesBtn = document.getElementById('refresh-prices-btn');
  if (refreshPricesBtn) {
    refreshPricesBtn.addEventListener('click', () => refreshPrices(false));
  }

  // Force refresh button
  const forceRefreshBtn = document.getElementById('force-refresh-btn');
  if (forceRefreshBtn) {
    forceRefreshBtn.addEventListener('click', () => refreshPrices(true));
  }

  // Duplicate details button
  const duplicateDetailsBtn = document.getElementById('duplicate-details-btn');
  if (duplicateDetailsBtn) {
    duplicateDetailsBtn.addEventListener('click', showDuplicateDetails);
  }

  // Initial price status update
  updatePriceStatus();
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

    if (!status.all_fresh && status.stale_tickers > 0) {
      console.log(
        `Auto-refreshing ${status.stale_tickers} stale ticker(s) (timezone: ${tz})`
      );
      const result = await apiCall<PriceRefreshResponse>(
        '/api/imports/refresh-prices',
        { method: 'POST' }
      );
      if (result.updated > 0) {
        showToast(`Auto-updated ${result.updated} stale price(s)`, 'info');
      }
    }
  } catch (error) {
    console.warn('Auto-refresh price check failed:', error);
  }
}

// Alias for compatibility
export const loadData = refreshData;
