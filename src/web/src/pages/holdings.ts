/**
 * Holdings page module.
 * Handles position display, sorting, filtering, and CRUD operations.
 */

import { apiCall } from '@/api/client';
import { store, SortConfig } from '@/state/store';
import { showToast } from '@/ui/toast';
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
 * Toggle multi-select dropdown open/closed.
 */
export function toggleMultiSelect(dropdownId: string): void {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;

  const wasOpen = dropdown.classList.contains('open');

  // Close all dropdowns first
  document.querySelectorAll('.multi-select-dropdown.open').forEach((d) => {
    d.classList.remove('open');
  });

  // Toggle this one
  if (!wasOpen) {
    dropdown.classList.add('open');
  }
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

  // Re-render holdings with new filter
  const positions = store.get('currentPositions');
  updateHoldings(positions);
}

/**
 * Update holdings table with positions.
 */
export function updateHoldings(positions: DashboardPosition[]): void {
  const tbody = document.querySelector('#holdings-table tbody');
  if (!tbody) return;

  // Clear existing rows
  tbody.textContent = '';

  // Apply sorting
  const currentSort = store.get('currentSort');
  const sorted = sortPositions(positions, currentSort.field, currentSort.direction);

  // Apply filters
  const filtered = filterPositionsList(sorted);

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

    // Actions cell
    const actionsCell = document.createElement('td');
    const dropdown = document.createElement('div');
    dropdown.className = 'actions-dropdown';

    const actionsBtn = document.createElement('button');
    actionsBtn.className = 'actions-btn';
    actionsBtn.textContent = 'Actions ';
    const arrow = document.createElement('span');
    arrow.textContent = '▼';
    actionsBtn.appendChild(arrow);
    actionsBtn.addEventListener('click', (e) =>
      toggleActionsMenu(e.currentTarget as HTMLButtonElement)
    );
    dropdown.appendChild(actionsBtn);

    const menu = document.createElement('div');
    menu.className = 'actions-menu';

    const editBtn = document.createElement('button');
    editBtn.textContent = '✏️ Edit';
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
    menu.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = '🗑️ Delete';
    deleteBtn.addEventListener('click', () => deletePosition(pos.id));
    menu.appendChild(deleteBtn);

    dropdown.appendChild(menu);
    actionsCell.appendChild(dropdown);
    row.appendChild(actionsCell);

    tbody.appendChild(row);
  });

  // Update sort indicators
  updateSortIndicators();
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

/**
 * Toggle actions dropdown menu.
 */
function toggleActionsMenu(btn: HTMLButtonElement): void {
  const dropdown = btn.closest('.actions-dropdown');
  if (!dropdown) return;

  dropdown.classList.toggle('open');

  // Close when clicking outside
  const closeMenu = (e: Event) => {
    if (!dropdown.contains(e.target as Node)) {
      dropdown.classList.remove('open');
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

/**
 * Delete a position.
 */
export async function deletePosition(positionId: string): Promise<void> {
  showConfirmDialog(
    'Are you sure you want to delete this position?',
    async () => {
      try {
        await apiCall(`/api/portfolio/positions/${positionId}`, { method: 'DELETE' });
        showToast('Position deleted', 'success');
        // Trigger refresh
        const event = new CustomEvent('holdings:positionDeleted');
        document.dispatchEvent(event);
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

  showEditPositionModalUI();
}

/**
 * Hide edit position modal.
 */
export function hideEditPositionModal(): void {
  hideEditPositionModalUI();
}

/**
 * Update position from edit form.
 */
export async function updatePosition(event: Event): Promise<void> {
  event.preventDefault();

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
    await apiCall(`/api/portfolio/positions/${positionId}`, {
      method: 'PUT',
      body: data,
    });
    showToast('Position updated', 'success');
    hideEditPositionModal();
    // Trigger refresh
    const refreshEvent = new CustomEvent('holdings:positionUpdated');
    document.dispatchEvent(refreshEvent);
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
  showAddPositionModalUI();
}

/**
 * Hide add position modal.
 */
export function hideAddPositionModal(): void {
  const newAccountForm = document.getElementById('new-account-form');
  const addPositionForm = document.getElementById('add-position-form') as HTMLFormElement | null;

  if (newAccountForm) newAccountForm.style.display = 'none';
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
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  }
}

/**
 * Create a new account.
 */
export async function createNewAccount(): Promise<void> {
  const nameEl = document.getElementById('new-account-name') as HTMLInputElement | null;
  const typeEl = document.getElementById('new-account-type') as HTMLSelectElement | null;
  const brokerageEl = document.getElementById('new-account-brokerage') as HTMLInputElement | null;

  const name = nameEl?.value.trim() || '';
  const accountType = typeEl?.value || 'taxable';
  const brokerage = brokerageEl?.value.trim() || 'other';

  if (!name) {
    showToast('Please enter an account name', 'error');
    return;
  }

  try {
    const result = await apiCall<CreatePositionResponse>('/api/portfolio/accounts', {
      method: 'POST',
      body: { name, account_type: accountType, brokerage },
    });

    await loadAccountsForSelect();
    const select = document.getElementById('position-account') as HTMLSelectElement | null;
    if (select) select.value = result.id;

    const form = document.getElementById('new-account-form');
    if (form) form.style.display = 'none';
    if (nameEl) nameEl.value = '';
    if (brokerageEl) brokerageEl.value = '';

    showToast(`Account "${name}" created`, 'success');
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

  let accountId =
    (document.getElementById('position-account') as HTMLSelectElement | null)?.value || '';

  // Check if new account form is visible and has data
  const newAccountForm = document.getElementById('new-account-form');
  const newAccountNameEl = document.getElementById('new-account-name') as HTMLInputElement | null;
  const newAccountName = newAccountNameEl?.value.trim() || '';

  if (newAccountForm && newAccountForm.style.display !== 'none' && newAccountName) {
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
    let response: CreatePositionResponse;

    if (posType === 'cash') {
      const amount = parseFloat(
        (document.getElementById('cash-amount') as HTMLInputElement | null)?.value || '0'
      );
      const name =
        (document.getElementById('cash-name') as HTMLInputElement | null)?.value || 'Cash';
      const apyInput = (document.getElementById('cash-apy') as HTMLInputElement | null)?.value;
      const apy = apyInput ? parseFloat(apyInput) / 100 : null;

      if (!amount) {
        showToast('Please enter a cash amount', 'error');
        return;
      }

      const cashData: Record<string, unknown> = { account_id: accountId, amount, name };
      if (apy !== null) cashData.interest_rate = apy;

      response = await apiCall<CreatePositionResponse>('/api/portfolio/positions/cash', {
        method: 'POST',
        body: cashData,
      });
    } else if (posType === 'cd') {
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
        showToast('Please fill in all CD fields', 'error');
        return;
      }

      response = await apiCall<CreatePositionResponse>('/api/portfolio/positions/cd', {
        method: 'POST',
        body: { account_id: accountId, amount, name, interest_rate: rate, maturity_date: maturity },
      });
    } else if (posType === 'real_estate') {
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
        showToast('Please fill in property name, current value, and cost basis', 'error');
        return;
      }

      const reData: Record<string, unknown> = {
        account_id: accountId,
        name,
        current_value: currentValue,
        cost_basis: costBasis,
      };
      if (purchaseDate) reData.purchase_date = purchaseDate;

      response = await apiCall<CreatePositionResponse>('/api/portfolio/positions/real-estate', {
        method: 'POST',
        body: reData,
      });
    } else {
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
      const priceInput = (document.getElementById('position-price') as HTMLInputElement | null)
        ?.value;
      const price = priceInput ? parseFloat(priceInput) : null;
      const costBasisInput = (
        document.getElementById('position-cost-basis') as HTMLInputElement | null
      )?.value;
      const costBasis = costBasisInput ? parseFloat(costBasisInput) : null;
      const isFund = posType === 'fund';

      if (!ticker || !shares) {
        showToast('Please enter ticker and shares', 'error');
        return;
      }

      response = await apiCall<CreatePositionResponse>('/api/portfolio/positions', {
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

    showToast(response.message || 'Position added', 'success');
    hideAddPositionModal();
    // Trigger refresh
    const refreshEvent = new CustomEvent('holdings:positionAdded');
    document.dispatchEvent(refreshEvent);
  } catch (error) {
    console.error('Error adding position:', error);
    showToast('Failed to add position', 'error');
  }
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

  // Add position form
  const addPositionForm = document.getElementById('add-position-form');
  if (addPositionForm) {
    addPositionForm.addEventListener('submit', addManualPosition);
  }

  // Edit position form
  const editPositionForm = document.getElementById('edit-position-form');
  if (editPositionForm) {
    editPositionForm.addEventListener('submit', updatePosition);
  }

  // Position type change handler
  const positionTypeSelect = document.getElementById('position-type');
  if (positionTypeSelect) {
    positionTypeSelect.addEventListener('change', togglePositionTypeFields);
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.multi-select-dropdown')) {
      document.querySelectorAll('.multi-select-dropdown.open').forEach((d) => {
        d.classList.remove('open');
      });
    }
  });

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
