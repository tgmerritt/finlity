/**
 * Holdings page module.
 * Handles position display, sorting, filtering, and CRUD operations.
 */

import { apiCall } from '@/api/client';
import { store, SortConfig } from '@/state/store';
import { emit } from '@/state/events';
import { showToast } from '@/ui/toast';
import { setStateView, clearStateView } from '@/ui/state-view';
import { withSubmitGuard } from '@/ui/with-submit-guard';
import {
  showConfirmDialog,
  showAddPositionModal as showAddPositionModalUI,
  hideAddPositionModal as hideAddPositionModalUI,
  showEditPositionModal as showEditPositionModalUI,
  hideEditPositionModal as hideEditPositionModalUI,
} from '@/ui/modal';
import { formatCurrency, formatShares, formatPercent } from '@/utils/format';
import type { DashboardPosition, AccountResponse, AccountTypeOption } from '@/types/api';

/**
 * Position update request data.
 */
interface PositionUpdateData {
  shares: number;
  current_price?: number;
  cost_basis?: number;
  interest_rate?: number;
  purchase_date?: string;
  maturity_date?: string;
}

/**
 * Create position response.
 */
interface CreatePositionResponse {
  id: string;
  message?: string;
}

/**
 * Format price with special handling for SGOV.
 */
function formatPrice(value: number | null | undefined, ticker?: string): string {
  if (value === null || value === undefined) return '-';
  const decimals = ticker && ticker.toUpperCase() === 'SGOV' ? 3 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Close every currently open `.multi-select-dropdown`. Exported so the
 * keyboard / outside-click handlers (and tests) can share one path.
 */
export function closeAllMultiSelects(): void {
  document.querySelectorAll('.multi-select-dropdown.open').forEach((d) => {
    d.classList.remove('open');
  });
}

/**
 * Toggle multi-select dropdown open/closed.
 */
export function toggleMultiSelect(dropdownId: string): void {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;

  const wasOpen = dropdown.classList.contains('open');

  // Close all dropdowns first
  closeAllMultiSelects();

  // Toggle this one
  if (!wasOpen) {
    dropdown.classList.add('open');
  }
}

// Module-scoped flag so the global outside-click / Escape listeners are only
// attached once, regardless of how many times init runs (e.g. in tests).
let multiSelectGlobalListenersAttached = false;

/**
 * Wire up document-level handlers that close any open multi-select dropdown
 * when the user clicks outside it or presses Escape. Idempotent.
 */
export function installMultiSelectAutoClose(): void {
  if (multiSelectGlobalListenersAttached) return;
  multiSelectGlobalListenersAttached = true;

  document.addEventListener('click', (e) => {
    // A click anywhere inside a `.multi-select-dropdown` (trigger or menu) is
    // handled by the dropdown's own logic; only outside clicks close.
    if (!(e.target as HTMLElement).closest('.multi-select-dropdown')) {
      closeAllMultiSelects();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllMultiSelects();
    }
  });
}

/**
 * Select or deselect all accounts in filter.
 */
export function selectAllAccounts(selectAll: boolean): void {
  const checkboxes = document.querySelectorAll('#account-filter-options input[type="checkbox"]');
  checkboxes.forEach((cb) => {
    (cb as HTMLInputElement).checked = selectAll;
  });
  handleAccountFilterChange();
}

/**
 * Refresh the account-filter trigger button label to reflect the current
 * selection. Without this the button stayed pinned at "All Accounts" even
 * after the user picked a subset, which was the reported "checkboxes don't
 * show selected" bug.
 */
export function updateAccountFilterLabel(): void {
  const labelEl = document.getElementById('account-filter-label');
  if (!labelEl) return;

  const allBoxes = document.querySelectorAll<HTMLInputElement>(
    '#account-filter-options input[type="checkbox"]'
  );
  const checkedBoxes = document.querySelectorAll<HTMLInputElement>(
    '#account-filter-options input[type="checkbox"]:checked'
  );
  const total = allBoxes.length;
  const selected = checkedBoxes.length;

  if (total === 0 || selected === 0) {
    labelEl.textContent = 'No Accounts';
  } else if (selected === total) {
    labelEl.textContent = 'All Accounts';
  } else if (selected === 1) {
    labelEl.textContent = checkedBoxes[0]?.value ?? 'Account';
  } else {
    labelEl.textContent = `${selected} of ${total} Accounts`;
  }
}

/**
 * Handle account filter checkbox changes.
 * Also exported as updateAccountFilter for compatibility.
 */
export function handleAccountFilterChange(): void {
  const checkedBoxes = document.querySelectorAll(
    '#account-filter-options input[type="checkbox"]:checked'
  );
  const selected = new Set<string>();
  checkedBoxes.forEach((cb) => {
    selected.add((cb as HTMLInputElement).value);
  });
  store.set('selectedAccounts', selected);

  // Update the trigger button label to reflect the new selection.
  updateAccountFilterLabel();

  // Re-render holdings with new filter
  const positions = store.get('currentPositions');
  updateHoldings(positions);
}

/**
 * Update holdings table with positions.
 */
export function updateHoldings(positions: DashboardPosition[]): void {
  // Split options from equity positions
  const optionPositions = positions.filter((p) => p.position_type === 'option');
  const equityPositions = positions.filter((p) => p.position_type !== 'option');

  // Update the options table independently
  updateOptionsTable(optionPositions);

  const table = document.getElementById('holdings-table') as HTMLTableElement | null;
  const tbody = table?.querySelector('tbody');
  const tableContainer = table?.closest('.table-container') as HTMLElement | null;
  if (!tbody || !table || !tableContainer) return;

  // Clear existing rows
  tbody.textContent = '';

  // Apply sorting
  const currentSort = store.get('currentSort');
  const sorted = sortPositions(equityPositions, currentSort.field, currentSort.direction);

  // Apply filters (only equity positions)
  const filtered = filterPositionsList(sorted);

  // Decide which non-data state (if any) to render. Two distinct UX cases:
  //  - No positions at all → onboarding empty state with "Add Position" CTA.
  //  - Filter excludes everything → "Clear filter" CTA (positions exist).
  if (equityPositions.length === 0) {
    table.style.display = 'none';
    setStateView(tableContainer, {
      kind: 'empty',
      title: 'No holdings yet',
      description: 'Import from a broker CSV or add a position manually to get started.',
      action: {
        label: 'Add Position',
        onClick: () => {
          showAddPositionModal().catch((err) => console.error('Failed to open modal:', err));
        },
      },
    });
    updateSortIndicators();
    return;
  }

  if (filtered.length === 0) {
    table.style.display = 'none';
    setStateView(tableContainer, {
      kind: 'empty',
      title: 'No holdings match the current filter',
      description: 'Try adjusting the search or account filter.',
      action: {
        label: 'Clear filter',
        onClick: () => {
          // Reset search input.
          const searchEl = document.getElementById('holdings-search') as HTMLInputElement | null;
          if (searchEl) searchEl.value = '';
          // Reset account filter to "All Accounts" (everything checked).
          const checkboxes = document.querySelectorAll<HTMLInputElement>(
            '#account-filter-options input[type="checkbox"]'
          );
          checkboxes.forEach((cb) => {
            cb.checked = true;
          });
          handleAccountFilterChange();
        },
      },
    });
    updateSortIndicators();
    return;
  }

  // We have filtered rows — restore the table and scrub any prior state-view.
  table.style.display = '';
  clearStateView(tableContainer);

  filtered.forEach((pos) => {
    const gainLoss = pos.cost_basis ? pos.value - pos.cost_basis : null;
    const gainLossPct = pos.cost_basis
      ? ((pos.value - pos.cost_basis) / pos.cost_basis) * 100
      : null;

    const row = document.createElement('tr');
    row.dataset.account = pos.account;

    // Ticker cell
    const tickerCell = document.createElement('td');
    const tickerStrong = document.createElement('strong');
    tickerStrong.textContent = pos.ticker;
    tickerCell.appendChild(tickerStrong);
    row.appendChild(tickerCell);

    // Name cell
    const nameCell = document.createElement('td');
    nameCell.textContent = pos.name || '-';
    row.appendChild(nameCell);

    // Account cell
    const accountCell = document.createElement('td');
    accountCell.textContent = pos.account;
    row.appendChild(accountCell);

    // Shares cell
    const sharesCell = document.createElement('td');
    sharesCell.className = 'text-right';
    sharesCell.textContent = formatShares(pos.shares);
    row.appendChild(sharesCell);

    // Price cell
    const priceCell = document.createElement('td');
    priceCell.className = 'text-right';
    const isRealEstate = pos.position_type === 'real_estate';
    if (isRealEstate) {
      if (pos.cost_basis) {
        priceCell.textContent = formatCurrency(pos.cost_basis);
      } else {
        const warning = document.createElement('span');
        warning.className = 'text-warning';
        warning.textContent = '$0.00';
        priceCell.appendChild(warning);
      }
    } else {
      if (pos.price) {
        priceCell.textContent = formatPrice(pos.price, pos.ticker);
      } else {
        const warning = document.createElement('span');
        warning.className = 'text-warning';
        warning.textContent = '$0.00';
        priceCell.appendChild(warning);
      }
    }
    row.appendChild(priceCell);

    // Value cell with optional APY indicator
    const valueCell = document.createElement('td');
    valueCell.className = 'text-right';
    if (pos.interest_rate && pos.interest_rate > 0) {
      const apyPct = (pos.interest_rate * 100).toFixed(2);
      const span = document.createElement('span');
      span.title = `Includes accrued interest at ${apyPct}% APY`;
      span.textContent = `${formatCurrency(pos.value)} 📈`;
      valueCell.appendChild(span);
    } else {
      valueCell.textContent = formatCurrency(pos.value);
    }
    row.appendChild(valueCell);

    // Gain/Loss cell
    const gainLossCell = document.createElement('td');
    gainLossCell.className = `text-right ${gainLoss !== null && gainLoss >= 0 ? 'text-success' : 'text-error'}`;
    if (gainLoss !== null) {
      gainLossCell.textContent = `${formatCurrency(gainLoss)} (${formatPercent(gainLossPct)})`;
    } else {
      gainLossCell.textContent = '-';
    }
    row.appendChild(gainLossCell);

    // Actions cell — inline icon buttons (edit / delete)
    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions-cell';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'icon-btn icon-btn-edit';
    editBtn.title = 'Edit position';
    editBtn.setAttribute('aria-label', 'Edit position');
    editBtn.appendChild(createEditIcon());
    editBtn.addEventListener('click', () => {
      showEditPositionModal(
        pos.id,
        pos.ticker,
        pos.shares,
        pos.price || 0,
        pos.cost_basis || 0,
        pos.position_type || 'equity',
        pos.interest_rate || null,
        pos.purchase_date || '',
        pos.maturity_date || ''
      );
    });
    actionsCell.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'icon-btn icon-btn-delete';
    deleteBtn.title = 'Delete position';
    deleteBtn.setAttribute('aria-label', 'Delete position');
    deleteBtn.appendChild(createTrashIcon());
    deleteBtn.addEventListener('click', () => deletePosition(pos.id));
    actionsCell.appendChild(deleteBtn);

    row.appendChild(actionsCell);

    tbody.appendChild(row);
  });

  // Update sort indicators
  updateSortIndicators();
}

/**
 * Format option expiration date as "MMM DD 'YY".
 */
function formatOptionExpiry(isoStr: string | null | undefined): string {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  } catch {
    return isoStr;
  }
}

/**
 * Render (or hide) the separate Options table.
 */
function updateOptionsTable(options: DashboardPosition[]): void {
  const section = document.getElementById('options-section');
  if (!section) return;

  if (options.length === 0) {
    section.style.display = 'none';
    return;
  }

  // Apply the same account filter used by the equity table
  const selectedAccounts = store.get('selectedAccounts');
  const filtered =
    selectedAccounts.size === 0 ? options : options.filter((p) => selectedAccounts.has(p.account));

  if (filtered.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const tbody = section.querySelector('#options-table tbody') as HTMLTableSectionElement | null;
  if (!tbody) return;

  tbody.textContent = '';

  let totalMktValue = 0;
  let totalGainLoss = 0;
  let hasGainLoss = false;

  filtered.forEach((pos) => {
    const contracts = pos.contracts ?? pos.shares;
    const premium = pos.premium ?? pos.price;
    const multiplier = pos.contract_multiplier ?? 100;
    const mktValue = contracts * multiplier * (premium ?? 0);
    const gainLoss = pos.cost_basis != null ? mktValue - pos.cost_basis : null;
    totalMktValue += mktValue;
    if (gainLoss != null) {
      totalGainLoss += gainLoss;
      hasGainLoss = true;
    }

    const optType = pos.option_type === 'C' ? 'Call' : pos.option_type === 'P' ? 'Put' : '-';
    const contractLabel = pos.option_underlying
      ? `${pos.option_underlying} ${pos.option_strike ? '$' + pos.option_strike : ''} ${optType.charAt(0)} ${formatOptionExpiry(pos.option_expiration)}`
      : pos.ticker;

    const row = document.createElement('tr');

    const cells: [string, string][] = [
      [contractLabel, ''],
      [pos.account, ''],
      [formatOptionExpiry(pos.option_expiration), 'text-right'],
      [pos.option_strike != null ? formatCurrency(pos.option_strike) : '-', 'text-right'],
      [optType, 'text-right'],
      [String(contracts), 'text-right'],
      [premium != null ? formatCurrency(premium) : '-', 'text-right'],
      [formatCurrency(mktValue), 'text-right'],
      [
        gainLoss != null ? formatCurrency(gainLoss) : '-',
        `text-right ${gainLoss != null && gainLoss >= 0 ? 'text-success' : 'text-error'}`,
      ],
    ];

    cells.forEach(([text, cls]) => {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      row.appendChild(td);
    });

    // Actions cell
    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions-cell';
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'icon-btn icon-btn-delete';
    deleteBtn.title = 'Delete position';
    deleteBtn.setAttribute('aria-label', 'Delete position');
    deleteBtn.appendChild(createTrashIcon());
    deleteBtn.addEventListener('click', () => deletePosition(pos.id));
    actionsCell.appendChild(deleteBtn);
    row.appendChild(actionsCell);

    tbody.appendChild(row);
  });

  // Subtotal row
  const totalValueEl = section.querySelector('#options-total-value');
  const totalGlEl = section.querySelector('#options-total-gl');
  if (totalValueEl) totalValueEl.textContent = formatCurrency(totalMktValue);
  // Update contract count label
  const contractCountEl = section.querySelector('#options-contract-count');
  if (contractCountEl)
    contractCountEl.textContent = `${filtered.length} contract${filtered.length !== 1 ? 's' : ''}`;
  if (totalGlEl) {
    totalGlEl.textContent = hasGainLoss ? formatCurrency(totalGainLoss) : '-';
    totalGlEl.className = totalGainLoss >= 0 ? 'text-success' : 'text-error';
  }
}

/**
 * Sort positions array by field and direction.
 */
export function sortPositions(
  positions: DashboardPosition[],
  field: string,
  direction: 'asc' | 'desc'
): DashboardPosition[] {
  return [...positions].sort((a, b) => {
    let aVal: string | number;
    let bVal: string | number;

    switch (field) {
      case 'ticker':
        aVal = a.ticker;
        bVal = b.ticker;
        break;
      case 'name':
        aVal = a.name || '';
        bVal = b.name || '';
        break;
      case 'account':
        aVal = a.account;
        bVal = b.account;
        break;
      case 'shares':
        aVal = a.shares;
        bVal = b.shares;
        break;
      case 'price':
        aVal = a.price || 0;
        bVal = b.price || 0;
        break;
      case 'value':
        aVal = a.value || 0;
        bVal = b.value || 0;
        break;
      case 'gain_loss':
        aVal = a.cost_basis ? a.value - a.cost_basis : -Infinity;
        bVal = b.cost_basis ? b.value - b.cost_basis : -Infinity;
        break;
      default:
        aVal = a.value || 0;
        bVal = b.value || 0;
    }

    if (typeof aVal === 'string') {
      return direction === 'asc'
        ? aVal.localeCompare(bVal as string)
        : (bVal as string).localeCompare(aVal);
    }
    return direction === 'asc' ? aVal - (bVal as number) : (bVal as number) - aVal;
  });
}

/**
 * Handle column header click for sorting.
 */
export function sortHoldings(field: string): void {
  const currentSort = store.get('currentSort');
  const newSort: SortConfig = {
    field,
    direction: currentSort.field === field && currentSort.direction === 'desc' ? 'asc' : 'desc',
  };
  store.set('currentSort', newSort);

  const positions = store.get('currentPositions');
  updateHoldings(positions);
}

/**
 * Update sort indicators on table headers.
 */
function updateSortIndicators(): void {
  const currentSort = store.get('currentSort');
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if ((th as HTMLElement).dataset.sort === currentSort.field) {
      th.classList.add(`sort-${currentSort.direction}`);
    }
  });
}

/**
 * Filter positions by search and account selection.
 */
function filterPositionsList(positions: DashboardPosition[]): DashboardPosition[] {
  const searchEl = document.getElementById('holdings-search') as HTMLInputElement | null;
  const search = searchEl?.value.toLowerCase() || '';
  const selectedAccounts = store.get('selectedAccounts');

  return positions.filter((pos) => {
    // Search filter
    const searchMatch =
      !search ||
      pos.ticker.toLowerCase().includes(search) ||
      (pos.name && pos.name.toLowerCase().includes(search)) ||
      pos.account.toLowerCase().includes(search);

    // Account filter
    const accountMatch = selectedAccounts.size === 0 || selectedAccounts.has(pos.account);

    return searchMatch && accountMatch;
  });
}

/**
 * Re-filter holdings on search input.
 */
export function filterHoldings(): void {
  const positions = store.get('currentPositions');
  updateHoldings(positions);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildSvg(paths: Array<{ tag: string; attrs: Record<string, string> }>): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const p of paths) {
    const el = document.createElementNS(SVG_NS, p.tag);
    for (const [k, v] of Object.entries(p.attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

function createEditIcon(): SVGSVGElement {
  return buildSvg([
    { tag: 'path', attrs: { d: 'M12 20h9' } },
    { tag: 'path', attrs: { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z' } },
  ]);
}

function createTrashIcon(): SVGSVGElement {
  return buildSvg([
    { tag: 'polyline', attrs: { points: '3 6 5 6 21 6' } },
    { tag: 'path', attrs: { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' } },
    { tag: 'path', attrs: { d: 'M10 11v6' } },
    { tag: 'path', attrs: { d: 'M14 11v6' } },
    { tag: 'path', attrs: { d: 'M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2' } },
  ]);
}

/**
 * Delete a position.
 */
export function deletePosition(positionId: string): void {
  showConfirmDialog(
    'Are you sure you want to delete this position?',
    async () => {
      try {
        await apiCall(`/api/portfolio/positions/${positionId}`, { method: 'DELETE' });
        showToast('Position deleted', 'success');
        // Trigger refresh — legacy event kept for the chain in main.ts;
        // typed bus is additive.
        const event = new CustomEvent('holdings:positionDeleted');
        document.dispatchEvent(event);
        emit({ type: 'positions:changed', reason: 'deleted' });
      } catch (error) {
        console.error('Error deleting position:', error);
        showToast('Failed to delete position', 'error');
      }
    },
    { title: 'Delete Position', confirmText: 'Delete', isDangerous: true }
  );
}

/**
 * Show edit position modal with position data.
 */
export function showEditPositionModal(
  id: string,
  ticker: string,
  shares: number,
  price: number,
  costBasis: number,
  positionType: string,
  interestRate: number | null,
  purchaseDate: string,
  maturityDate: string
): void {
  const idEl = document.getElementById('edit-position-id') as HTMLInputElement | null;
  const typeEl = document.getElementById('edit-position-type') as HTMLSelectElement | null;
  const tickerEl = document.getElementById('edit-position-ticker') as HTMLInputElement | null;
  const sharesEl = document.getElementById('edit-position-shares') as HTMLInputElement | null;
  const priceEl = document.getElementById('edit-position-price') as HTMLInputElement | null;
  const costBasisEl = document.getElementById(
    'edit-position-cost-basis'
  ) as HTMLInputElement | null;

  if (idEl) idEl.value = id;
  if (typeEl) typeEl.value = positionType || 'equity';
  if (tickerEl) tickerEl.value = ticker;
  if (sharesEl) sharesEl.value = shares.toString();
  if (priceEl) priceEl.value = price ? price.toString() : '';
  if (costBasisEl) costBasisEl.value = costBasis ? costBasis.toString() : '';

  // Handle interest/APY fields for cash, CD, bond positions
  const interestFields = document.getElementById('edit-interest-fields');
  const showInterestFields = ['cash', 'cd', 'bond', 'treasury'].includes(positionType);
  if (interestFields) {
    interestFields.style.display = showInterestFields ? 'block' : 'none';
  }

  if (showInterestFields) {
    const apyEl = document.getElementById('edit-position-apy') as HTMLInputElement | null;
    const purchaseDateEl = document.getElementById(
      'edit-position-purchase-date'
    ) as HTMLInputElement | null;
    const maturityDateEl = document.getElementById(
      'edit-position-maturity-date'
    ) as HTMLInputElement | null;

    if (apyEl) apyEl.value = interestRate ? (interestRate * 100).toFixed(2) : '';
    if (purchaseDateEl) purchaseDateEl.value = purchaseDate || '';
    if (maturityDateEl) maturityDateEl.value = maturityDate || '';
  }

  // Always reset the submit button — a prior in-flight save may have left it
  // disabled with "Saving..." text. Opening the modal means a fresh intent to edit.
  const form = document.getElementById('edit-position-form') as HTMLFormElement | null;
  const submitBtn = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save';
    submitBtn.removeAttribute('aria-busy');
  }

  showEditPositionModalUI();
}

/**
 * Hide edit position modal.
 */
export function hideEditPositionModal(): void {
  hideEditPositionModalUI();
}

/**
 * Locate a form's submit button. Forms in this codebase don't carry IDs on
 * their submit buttons (they're styled by class), so reach for them via the
 * form itself.
 */
function findSubmitButton(form: HTMLFormElement | null): HTMLButtonElement | null {
  if (!form) return null;
  return form.querySelector<HTMLButtonElement>('button[type="submit"]');
}

/**
 * Update position from edit form.
 */
export async function updatePosition(event: Event): Promise<void> {
  event.preventDefault();

  const submitBtn = findSubmitButton(event.target as HTMLFormElement | null);

  const positionId = (document.getElementById('edit-position-id') as HTMLInputElement | null)
    ?.value;
  const positionType =
    (document.getElementById('edit-position-type') as HTMLSelectElement | null)?.value || 'equity';
  const sharesInput = (document.getElementById('edit-position-shares') as HTMLInputElement | null)
    ?.value;
  const priceInput = (document.getElementById('edit-position-price') as HTMLInputElement | null)
    ?.value;
  const costBasisInput = (
    document.getElementById('edit-position-cost-basis') as HTMLInputElement | null
  )?.value;

  if (!positionId || !sharesInput) {
    showToast('Missing required fields', 'error');
    return;
  }

  const data: PositionUpdateData = {
    shares: parseFloat(sharesInput),
  };
  if (priceInput) data.current_price = parseFloat(priceInput);
  if (costBasisInput) data.cost_basis = parseFloat(costBasisInput);

  // Include interest fields for cash/CD/bond positions
  if (['cash', 'cd', 'bond', 'treasury'].includes(positionType)) {
    const apyValue = (document.getElementById('edit-position-apy') as HTMLInputElement | null)
      ?.value;
    const purchaseDate = (
      document.getElementById('edit-position-purchase-date') as HTMLInputElement | null
    )?.value;
    const maturityDate = (
      document.getElementById('edit-position-maturity-date') as HTMLInputElement | null
    )?.value;

    if (apyValue) data.interest_rate = parseFloat(apyValue) / 100;
    if (purchaseDate) data.purchase_date = purchaseDate;
    if (maturityDate) data.maturity_date = maturityDate;
  }

  try {
    await withSubmitGuard(submitBtn, 'Saving...', async () => {
      await apiCall(`/api/portfolio/positions/${positionId}`, {
        method: 'PUT',
        body: data,
      });
    });
    showToast('Position updated', 'success');
    hideEditPositionModal();
    // Trigger refresh
    const refreshEvent = new CustomEvent('holdings:positionUpdated');
    document.dispatchEvent(refreshEvent);
    emit({ type: 'positions:changed', reason: 'updated' });
  } catch (error) {
    console.error('Error updating position:', error);
    showToast('Failed to update position', 'error');
  }
}

/**
 * Show add position modal.
 */
export async function showAddPositionModal(): Promise<void> {
  const positionTypeEl = document.getElementById('position-type') as HTMLSelectElement | null;
  if (positionTypeEl) {
    positionTypeEl.value = 'equity';
  }
  togglePositionTypeFields();
  await loadAccountsForSelect();
  await loadAccountTypesForSelect();

  // Reset submit button in case a prior in-flight create left it stuck.
  const addForm = document.getElementById('add-position-form') as HTMLFormElement | null;
  const addSubmitBtn = addForm?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (addSubmitBtn) {
    addSubmitBtn.disabled = false;
    addSubmitBtn.textContent = 'Add Position';
    addSubmitBtn.removeAttribute('aria-busy');
  }

  showAddPositionModalUI();
}

/**
 * Hide add position modal.
 */
export function hideAddPositionModal(): void {
  const newAccountForm = document.getElementById('new-account-form');
  const addPositionForm = document.getElementById('add-position-form') as HTMLFormElement | null;

  if (newAccountForm) newAccountForm.classList.add('hidden');
  if (addPositionForm) addPositionForm.reset();
  hideAddPositionModalUI();
}

/**
 * Toggle position type fields based on selection.
 */
export function togglePositionTypeFields(): void {
  const posTypeEl = document.getElementById('position-type') as HTMLSelectElement | null;
  const posType = posTypeEl?.value || 'equity';

  const stockFields = document.getElementById('stock-fields');
  const cashFields = document.getElementById('cash-fields');
  const cdFields = document.getElementById('cd-fields');
  const realEstateFields = document.getElementById('real-estate-fields');

  if (stockFields)
    stockFields.style.display = posType === 'equity' || posType === 'fund' ? 'block' : 'none';
  if (cashFields) cashFields.style.display = posType === 'cash' ? 'block' : 'none';
  if (cdFields) cdFields.style.display = posType === 'cd' ? 'block' : 'none';
  if (realEstateFields)
    realEstateFields.style.display = posType === 'real_estate' ? 'block' : 'none';
}

/**
 * Load accounts for position account select.
 */
async function loadAccountsForSelect(): Promise<void> {
  try {
    const accounts = await apiCall<AccountResponse[]>('/api/portfolio/accounts');

    const select = document.getElementById('position-account') as HTMLSelectElement | null;
    if (!select) return;

    select.textContent = '';

    if (accounts.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '-- Create an account first --';
      select.appendChild(option);
    } else {
      accounts.forEach((acc) => {
        const option = document.createElement('option');
        option.value = acc.id;
        option.textContent = `${acc.name} (${acc.brokerage})`;
        select.appendChild(option);
      });
    }
  } catch (error) {
    console.error('Error loading accounts:', error);
  }
}

/**
 * Load account types for new account select.
 */
async function loadAccountTypesForSelect(): Promise<void> {
  try {
    const types = await apiCall<AccountTypeOption[]>('/api/portfolio/account-types');

    const select = document.getElementById('new-account-type') as HTMLSelectElement | null;
    if (!select) return;

    select.textContent = '';

    types.forEach((type) => {
      const option = document.createElement('option');
      option.value = type.value;
      option.textContent = type.label;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Error loading account types:', error);
  }
}

/**
 * Toggle new account form visibility.
 */
export function showNewAccountForm(): void {
  const form = document.getElementById('new-account-form');
  if (form) {
    form.classList.toggle('hidden');
  }
}

/**
 * Create a new account.
 *
 * The "Create Account" button in the inline form is `type="button"` (calls
 * this function via onclick), so we resolve it from the nested-form scope
 * rather than by ID. withSubmitGuard guards against rapid double-click.
 */
export async function createNewAccount(): Promise<void> {
  const nameEl = document.getElementById('new-account-name') as HTMLInputElement | null;
  const typeEl = document.getElementById('new-account-type') as HTMLSelectElement | null;
  const brokerageEl = document.getElementById('new-account-brokerage') as HTMLInputElement | null;
  const newAccountForm = document.getElementById('new-account-form');
  const submitBtn =
    newAccountForm?.querySelector<HTMLButtonElement>('button.btn.btn-default') ?? null;

  const name = nameEl?.value.trim() || '';
  const accountType = typeEl?.value || 'taxable';
  const brokerage = brokerageEl?.value.trim() || 'other';

  if (!name) {
    showToast('Please enter an account name', 'error');
    return;
  }

  try {
    const result = await withSubmitGuard(submitBtn, 'Creating...', () =>
      apiCall<CreatePositionResponse>('/api/portfolio/accounts', {
        method: 'POST',
        body: { name, account_type: accountType, brokerage },
      })
    );

    await loadAccountsForSelect();
    const select = document.getElementById('position-account') as HTMLSelectElement | null;
    if (select) select.value = result.id;

    const form = document.getElementById('new-account-form');
    if (form) form.classList.add('hidden');
    if (nameEl) nameEl.value = '';
    if (brokerageEl) brokerageEl.value = '';

    showToast(`Account "${name}" created`, 'success');
    emit({ type: 'accounts:changed', reason: 'added' });
  } catch (error) {
    console.error('Error creating account:', error);
    showToast('Failed to create account', 'error');
  }
}

/**
 * Add a manual position from form.
 */
export async function addManualPosition(event: Event): Promise<void> {
  event.preventDefault();

  const submitBtn = findSubmitButton(event.target as HTMLFormElement | null);

  let accountId =
    (document.getElementById('position-account') as HTMLSelectElement | null)?.value || '';

  // Check if new account form is visible and has data
  const newAccountForm = document.getElementById('new-account-form');
  const newAccountNameEl = document.getElementById('new-account-name') as HTMLInputElement | null;
  const newAccountName = newAccountNameEl?.value.trim() || '';

  if (newAccountForm && !newAccountForm.classList.contains('hidden') && newAccountName) {
    // Auto-create the new account first
    const accountType =
      (document.getElementById('new-account-type') as HTMLSelectElement | null)?.value || 'taxable';
    const brokerage =
      (document.getElementById('new-account-brokerage') as HTMLInputElement | null)?.value.trim() ||
      'other';

    try {
      const result = await apiCall<CreatePositionResponse>('/api/portfolio/accounts', {
        method: 'POST',
        body: { name: newAccountName, account_type: accountType, brokerage },
      });

      showToast(`Account "${newAccountName}" created`, 'success');
      accountId = result.id;
      newAccountForm.style.display = 'none';
      await loadAccountsForSelect();
      const select = document.getElementById('position-account') as HTMLSelectElement | null;
      if (select) select.value = accountId;
      // Deliberately NOT emitting accounts:changed here — the
      // positions:changed event below triggers the refresh, which
      // re-fetches summary.accounts and surfaces the new account in the
      // filter. Emitting both would cause two back-to-back refreshData()
      // calls and a double loading-flash.
    } catch (error) {
      console.error('Error auto-creating account:', error);
      showToast('Failed to create account', 'error');
      return;
    }
  }

  if (!accountId) {
    showToast('Please select an account first', 'error');
    return;
  }

  const posType =
    (document.getElementById('position-type') as HTMLSelectElement | null)?.value || 'equity';

  try {
    const response = await withSubmitGuard<CreatePositionResponse>(
      submitBtn,
      'Adding...',
      async () => buildAndSubmitPosition(posType, accountId)
    );

    showToast(response.message || 'Position added', 'success');
    hideAddPositionModal();
    // Trigger refresh
    const refreshEvent = new CustomEvent('holdings:positionAdded');
    document.dispatchEvent(refreshEvent);
    emit({ type: 'positions:changed', reason: 'added' });
  } catch (error) {
    console.error('Error adding position:', error);
    // Surface validation errors thrown by buildAndSubmitPosition; fall back
    // to a generic toast for API failures.
    const message =
      error instanceof Error && error.message ? error.message : 'Failed to add position';
    showToast(message, 'error');
  }
}

/**
 * Build the position payload and call the right /api/portfolio/positions
 * endpoint based on position type. Extracted from `addManualPosition` so the
 * submit-guard can wrap a single async unit instead of the whole function
 * (which would also disable the button during local validation).
 */
async function buildAndSubmitPosition(
  posType: string,
  accountId: string
): Promise<CreatePositionResponse> {
  if (posType === 'cash') {
    const amount = parseFloat(
      (document.getElementById('cash-amount') as HTMLInputElement | null)?.value || '0'
    );
    const name = (document.getElementById('cash-name') as HTMLInputElement | null)?.value || 'Cash';
    const apyInput = (document.getElementById('cash-apy') as HTMLInputElement | null)?.value;
    const apy = apyInput ? parseFloat(apyInput) / 100 : null;

    if (!amount) {
      throw new Error('Please enter a cash amount');
    }

    const cashData: Record<string, unknown> = { account_id: accountId, amount, name };
    if (apy !== null) cashData.interest_rate = apy;

    return apiCall<CreatePositionResponse>('/api/portfolio/positions/cash', {
      method: 'POST',
      body: cashData,
    });
  }

  if (posType === 'cd') {
    const amount = parseFloat(
      (document.getElementById('cd-amount') as HTMLInputElement | null)?.value || '0'
    );
    const name = (document.getElementById('cd-name') as HTMLInputElement | null)?.value || '';
    const rate =
      parseFloat((document.getElementById('cd-rate') as HTMLInputElement | null)?.value || '0') /
      100;
    const maturity =
      (document.getElementById('cd-maturity') as HTMLInputElement | null)?.value || '';

    if (!amount || !name || !rate || !maturity) {
      throw new Error('Please fill in all CD fields');
    }

    return apiCall<CreatePositionResponse>('/api/portfolio/positions/cd', {
      method: 'POST',
      body: { account_id: accountId, amount, name, interest_rate: rate, maturity_date: maturity },
    });
  }

  if (posType === 'real_estate') {
    const name =
      (document.getElementById('re-name') as HTMLInputElement | null)?.value.trim() || '';
    const currentValue = parseFloat(
      (document.getElementById('re-value') as HTMLInputElement | null)?.value || '0'
    );
    const costBasis = parseFloat(
      (document.getElementById('re-cost') as HTMLInputElement | null)?.value || '0'
    );
    const purchaseDate =
      (document.getElementById('re-purchase-date') as HTMLInputElement | null)?.value || null;

    if (!name || !currentValue || !costBasis) {
      throw new Error('Please fill in property name, current value, and cost basis');
    }

    const reData: Record<string, unknown> = {
      account_id: accountId,
      name,
      current_value: currentValue,
      cost_basis: costBasis,
    };
    if (purchaseDate) reData.purchase_date = purchaseDate;

    return apiCall<CreatePositionResponse>('/api/portfolio/positions/real-estate', {
      method: 'POST',
      body: reData,
    });
  }

  // Stock/fund position
  const ticker =
    (document.getElementById('position-ticker') as HTMLInputElement | null)?.value
      .trim()
      .toUpperCase() || '';
  const name =
    (document.getElementById('position-name') as HTMLInputElement | null)?.value.trim() || null;
  const shares = parseFloat(
    (document.getElementById('position-shares') as HTMLInputElement | null)?.value || '0'
  );
  const priceInput = (document.getElementById('position-price') as HTMLInputElement | null)?.value;
  const price = priceInput ? parseFloat(priceInput) : null;
  const costBasisInput = (document.getElementById('position-cost-basis') as HTMLInputElement | null)
    ?.value;
  const costBasis = costBasisInput ? parseFloat(costBasisInput) : null;
  const isFund = posType === 'fund';

  if (!ticker || !shares) {
    throw new Error('Please enter ticker and shares');
  }

  return apiCall<CreatePositionResponse>('/api/portfolio/positions', {
    method: 'POST',
    body: {
      account_id: accountId,
      ticker,
      shares,
      name,
      current_price: price,
      cost_basis: costBasis,
      is_fund: isFund,
      position_type: posType,
    },
  });
}

/**
 * Update account filter - alias for handleAccountFilterChange.
 */
export const updateAccountFilter = handleAccountFilterChange;

/**
 * Initialize holdings page event handlers.
 */
export function initHoldings(): void {
  // Search input handler
  const searchInput = document.getElementById('holdings-search');
  if (searchInput) {
    searchInput.addEventListener('input', filterHoldings);
  }

  // Sort handlers for table headers
  document.querySelectorAll('#holdings-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const field = (th as HTMLElement).dataset.sort;
      if (field) sortHoldings(field);
    });
  });

  // Add position button
  const addPositionBtn = document.getElementById('add-position-btn');
  if (addPositionBtn) {
    addPositionBtn.addEventListener('click', showAddPositionModal);
  }

  // Add position and edit position forms use the inline onsubmit="" handler
  // in index.html — do not also bind here, or the submit fires twice.

  // Position type change handler
  const positionTypeSelect = document.getElementById('position-type');
  if (positionTypeSelect) {
    positionTypeSelect.addEventListener('change', togglePositionTypeFields);
  }

  // Close dropdowns on outside click or Escape (idempotent, single delegated
  // pair of listeners regardless of how many dropdowns exist).
  installMultiSelectAutoClose();

  // Listen for position updates from dashboard
  document.addEventListener('dashboard:positionsUpdated', ((e: CustomEvent) => {
    updateHoldings(e.detail);
  }) as EventListener);

  // Listen for account filter changes
  document.addEventListener('accountFilter:changed', () => {
    const positions = store.get('currentPositions');
    updateHoldings(positions);
  });

  // Listen for position CRUD events to refresh data
  const refreshHandler = () => {
    const event = new CustomEvent('holdings:refreshRequested');
    document.dispatchEvent(event);
  };
  document.addEventListener('holdings:positionDeleted', refreshHandler);
  document.addEventListener('holdings:positionUpdated', refreshHandler);
  document.addEventListener('holdings:positionAdded', refreshHandler);
}
