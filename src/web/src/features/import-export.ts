/**
 * Import/Export Feature
 * Handles CSV/Excel file imports and data exports.
 */

import { apiCall, getBaseUrl, uploadFile } from '@/api/client';
import { showToast } from '@/ui/toast';
import { showLoading, hideLoading } from '@/ui/loading';
import { getElementById, setVisible, clearElement } from '@/utils/html';

/**
 * Parsed position from import.
 */
export interface ImportPosition {
  ticker?: string;
  name?: string;
  shares?: number;
  price?: number;
  cost_basis?: number;
}

/**
 * Parse result from API.
 */
interface ParseResult {
  positions: ImportPosition[];
  suggested_account?: {
    id?: string;
    name: string;
    reason: string;
  };
}

/**
 * Account for import dropdown.
 */
interface ImportAccount {
  id: string;
  name: string;
  brokerage: string;
}

/**
 * Account type for dropdown.
 */
interface AccountType {
  value: string;
  label: string;
}

/**
 * Import result from API.
 */
interface ImportResult {
  imported_count: number;
  detail?: string;
}

/**
 * Pending import data storage.
 */
let pendingImportData: ParseResult | null = null;

/**
 * Selected database file handle for local mode.
 */
let selectedDbFileHandle: FileSystemFileHandle | null = null;

/**
 * Export data to CSV file.
 */
export async function exportToCSV(dataType: string): Promise<void> {
  try {
    showLoading(`Exporting ${dataType}...`);

    const baseUrl = getBaseUrl();
    const response = await fetch(`${baseUrl}/api/portfolio/export/${dataType}`);

    if (!response.ok) {
      throw new Error(`Failed to export ${dataType}`);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().slice(0, 10);
    a.download = `portfolio_${dataType}_${timestamp}.csv`;

    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();

    showToast(
      `${dataType.charAt(0).toUpperCase() + dataType.slice(1)} exported successfully`,
      'success'
    );
  } catch (error) {
    console.error(`Error exporting ${dataType}:`, error);
    showToast(`Failed to export ${dataType}`, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Export all data types to CSV files.
 */
export async function exportAllToCSV(): Promise<void> {
  try {
    showLoading('Exporting all data...');

    // Export each type sequentially
    const types = ['accounts', 'positions', 'snapshots'];
    const timestamp = new Date().toISOString().slice(0, 10);

    for (const dataType of types) {
      const baseUrl = getBaseUrl();
      const response = await fetch(`${baseUrl}/api/portfolio/export/${dataType}`);

      if (!response.ok) {
        console.error(`Failed to export ${dataType}`);
        continue;
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `portfolio_${dataType}_${timestamp}.csv`;

      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();

      // Small delay between downloads
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    showToast('All data exported successfully', 'success');
  } catch (error) {
    console.error('Error exporting all data:', error);
    showToast('Failed to export data', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Handle drag over event.
 */
export function handleDragOver(event: DragEvent): void {
  event.preventDefault();
  event.stopPropagation();
  (event.currentTarget as HTMLElement)?.classList.add('drag-over');
}

/**
 * Handle drag leave event.
 */
export function handleDragLeave(event: DragEvent): void {
  event.preventDefault();
  event.stopPropagation();
  (event.currentTarget as HTMLElement)?.classList.remove('drag-over');
}

/**
 * Handle file drop.
 */
export async function handleFileDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  (event.currentTarget as HTMLElement)?.classList.remove('drag-over');

  const files = event.dataTransfer?.files;
  if (files && files.length > 0 && files[0]) {
    await processImportFile(files[0]);
  }
}

/**
 * Handle file select from input.
 */
export async function handleFileSelect(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = input.files;

  if (files && files.length > 0 && files[0]) {
    await processImportFile(files[0]);
  }

  // Reset input so same file can be selected again
  input.value = '';
}

/**
 * Process the imported file.
 */
export async function processImportFile(file: File): Promise<void> {
  const validTypes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];
  const validExtensions = ['.csv', '.xls', '.xlsx'];

  const hasValidExt = validExtensions.some((ext) => file.name.toLowerCase().endsWith(ext));
  if (!hasValidExt && !validTypes.includes(file.type)) {
    showToast('Please upload a CSV or Excel file', 'error');
    return;
  }

  // Show processing status
  const statusDiv = getElementById<HTMLElement>('file-import-status');
  const statusText = getElementById<HTMLElement>('file-import-status-text');

  setVisible(statusDiv, true);
  if (statusText) statusText.textContent = 'Uploading and analyzing file...';

  try {
    // Upload and parse file
    const result = await uploadFile<ParseResult>('/api/import/parse', file);

    // Store parsed data
    pendingImportData = result;

    // Hide status
    setVisible(statusDiv, false);

    // Show confirmation modal
    await showImportConfirmModal(file.name, result);
  } catch (error) {
    console.error('Error processing file:', error);
    setVisible(statusDiv, false);
    showToast(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
  }
}

/**
 * Show import confirmation modal.
 */
async function showImportConfirmModal(filename: string, parseResult: ParseResult): Promise<void> {
  // Set filename
  const filenameEl = document.querySelector('.import-filename');
  if (filenameEl) filenameEl.textContent = filename;

  // Load accounts for select
  await loadImportAccounts();
  await loadImportAccountTypes();

  // Show AI suggestion if available
  const suggestionDiv = getElementById<HTMLElement>('import-account-suggestion');
  const suggestionText = getElementById<HTMLElement>('import-ai-suggestion');

  if (parseResult.suggested_account) {
    setVisible(suggestionDiv, true, 'flex');
    if (suggestionText) {
      suggestionText.textContent = `AI suggests: ${parseResult.suggested_account.name} (${parseResult.suggested_account.reason})`;
    }

    // Pre-select the suggested account
    const select = getElementById<HTMLSelectElement>('import-account');
    if (select && parseResult.suggested_account.id) {
      select.value = parseResult.suggested_account.id;
    }
  } else {
    setVisible(suggestionDiv, false);
  }

  // Populate positions preview table
  const tbody = getElementById<HTMLTableSectionElement>('import-preview-body');
  if (tbody) {
    clearElement(tbody);

    const positions = parseResult.positions || [];
    const countEl = getElementById<HTMLElement>('import-position-count');
    if (countEl) countEl.textContent = String(positions.length);

    positions.forEach((pos, index) => {
      const value = (pos.shares || 0) * (pos.price || 0);
      const row = document.createElement('tr');

      // Checkbox cell
      const checkCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'import-position-check';
      checkbox.dataset.index = String(index);
      checkbox.checked = true;
      checkCell.appendChild(checkbox);
      row.appendChild(checkCell);

      // Ticker cell
      const tickerCell = document.createElement('td');
      tickerCell.textContent = pos.ticker || 'N/A';
      row.appendChild(tickerCell);

      // Name cell
      const nameCell = document.createElement('td');
      nameCell.textContent = pos.name || '-';
      row.appendChild(nameCell);

      // Shares cell
      const sharesCell = document.createElement('td');
      sharesCell.className = 'text-right';
      sharesCell.textContent = pos.shares
        ? pos.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })
        : '-';
      row.appendChild(sharesCell);

      // Price cell
      const priceCell = document.createElement('td');
      priceCell.className = 'text-right';
      priceCell.textContent = pos.price
        ? '$' +
          pos.price.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        : '-';
      row.appendChild(priceCell);

      // Value cell
      const valueCell = document.createElement('td');
      valueCell.className = 'text-right';
      valueCell.textContent =
        value > 0
          ? '$' +
            value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : '-';
      row.appendChild(valueCell);

      tbody.appendChild(row);
    });
  }

  // Show modal
  const modal = getElementById<HTMLElement>('import-confirm-modal');
  if (modal) modal.style.display = 'flex';
}

/**
 * Load accounts for import modal select.
 */
async function loadImportAccounts(): Promise<void> {
  try {
    const accounts = await apiCall<ImportAccount[]>('/api/portfolio/accounts');

    const select = getElementById<HTMLSelectElement>('import-account');
    if (!select) return;

    clearElement(select);

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
 * Load account types for import modal.
 */
async function loadImportAccountTypes(): Promise<void> {
  try {
    const types = await apiCall<AccountType[]>('/api/portfolio/account-types');

    const select = getElementById<HTMLSelectElement>('import-new-account-type');
    if (!select) return;

    clearElement(select);

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
 * Hide import modal.
 */
export function hideImportModal(): void {
  const modal = getElementById<HTMLElement>('import-confirm-modal');
  const form = getElementById<HTMLElement>('import-new-account-form');

  if (modal) modal.style.display = 'none';
  if (form) form.style.display = 'none';

  pendingImportData = null;
}

/**
 * Show new account form in import modal.
 */
export function showImportNewAccountForm(): void {
  const form = getElementById<HTMLElement>('import-new-account-form');
  if (form) {
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  }
}

/**
 * Create account from import modal.
 */
export async function createImportAccount(): Promise<void> {
  const nameInput = getElementById<HTMLInputElement>('import-new-account-name');
  const typeSelect = getElementById<HTMLSelectElement>('import-new-account-type');
  const brokerageInput = getElementById<HTMLInputElement>('import-new-account-brokerage');

  const name = nameInput?.value.trim();
  const accountType = typeSelect?.value;
  const brokerage = brokerageInput?.value.trim() || 'other';

  if (!name) {
    showToast('Please enter an account name', 'error');
    return;
  }

  try {
    const result = await apiCall<{ id: string }>('/api/portfolio/accounts', {
      method: 'POST',
      body: { name, account_type: accountType, brokerage },
    });

    showToast('Account created', 'success');

    // Reload accounts and select the new one
    await loadImportAccounts();

    const select = getElementById<HTMLSelectElement>('import-account');
    if (select) select.value = result.id;

    const form = getElementById<HTMLElement>('import-new-account-form');
    if (form) form.style.display = 'none';
  } catch (error) {
    console.error('Error creating account:', error);
    showToast(
      error instanceof Error ? `Error: ${error.message}` : 'Failed to create account',
      'error'
    );
  }
}

/**
 * Toggle all import position checkboxes.
 */
export function toggleAllImportPositions(): void {
  const selectAll = getElementById<HTMLInputElement>('import-select-all');
  const isChecked = selectAll?.checked ?? false;

  document.querySelectorAll<HTMLInputElement>('.import-position-check').forEach((cb) => {
    cb.checked = isChecked;
  });
}

/**
 * Confirm and execute import.
 */
export async function confirmImport(refreshDataCallback: () => Promise<void>): Promise<void> {
  const accountSelect = getElementById<HTMLSelectElement>('import-account');
  const accountId = accountSelect?.value;

  if (!accountId) {
    showToast('Please select an account', 'error');
    return;
  }

  if (!pendingImportData || !pendingImportData.positions) {
    showToast('No data to import', 'error');
    return;
  }

  // Get selected positions
  const selectedIndices: number[] = [];
  document.querySelectorAll<HTMLInputElement>('.import-position-check:checked').forEach((cb) => {
    const index = parseInt(cb.dataset.index || '0', 10);
    selectedIndices.push(index);
  });

  if (selectedIndices.length === 0) {
    showToast('Please select at least one position to import', 'error');
    return;
  }

  const selectedPositions = selectedIndices.map((i) => pendingImportData!.positions[i]);
  const replaceCheckbox = getElementById<HTMLInputElement>('import-replace');
  const replaceExisting = replaceCheckbox?.checked ?? false;

  // Show loading state
  const btn = getElementById<HTMLButtonElement>('confirm-import-btn');
  const btnText = btn?.querySelector('.btn-text') as HTMLElement | null;
  const btnLoading = btn?.querySelector('.btn-loading') as HTMLElement | null;

  if (btn) btn.disabled = true;
  setVisible(btnText, false);
  setVisible(btnLoading, true, 'inline-flex');

  try {
    const result = await apiCall<ImportResult>('/api/import/positions', {
      method: 'POST',
      body: {
        account_id: accountId,
        positions: selectedPositions,
        replace_existing: replaceExisting,
      },
    });

    showToast(`Successfully imported ${result.imported_count} positions`, 'success');
    hideImportModal();
    await refreshDataCallback();
  } catch (error) {
    console.error('Error importing positions:', error);
    showToast(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
  } finally {
    // Reset button
    if (btn) btn.disabled = false;
    setVisible(btnText, true);
    setVisible(btnLoading, false);
  }
}

/**
 * Browse for existing database file.
 */
export async function browseExistingDatabase(): Promise<void> {
  // Check for File System Access API support
  if (!('showOpenFilePicker' in window)) {
    showToast(
      'Your browser does not support file selection. Please use Chrome, Edge, or another modern browser.',
      'error'
    );
    return;
  }

  try {
    // Use unknown cast for File System Access API
    const windowWithPicker = window as unknown as {
      showOpenFilePicker: (options: unknown) => Promise<FileSystemFileHandle[]>;
    };
    const [handle] = await windowWithPicker.showOpenFilePicker({
      types: [
        {
          description: 'SQLite Database',
          accept: { 'application/x-sqlite3': ['.db'] },
        },
      ],
      multiple: false,
    });

    if (!handle) return;
    selectedDbFileHandle = handle;
    const file = await handle.getFile();

    // Update UI
    const selectedFileEl = getElementById<HTMLElement>('selected-db-file');
    if (selectedFileEl) {
      selectedFileEl.textContent = file.name;
      selectedFileEl.classList.add('has-file');
    }

    showToast(`Selected: ${file.name}`, 'success');
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      console.error('Failed to select file:', error);
      showToast('Failed to select database file', 'error');
    }
  }
}

/**
 * Get the selected database file handle.
 */
export function getSelectedDbFileHandle(): FileSystemFileHandle | null {
  return selectedDbFileHandle;
}

/**
 * Clear the selected database file handle.
 */
export function clearSelectedDbFileHandle(): void {
  selectedDbFileHandle = null;
}

/**
 * Get pending import data.
 */
export function getPendingImportData(): ParseResult | null {
  return pendingImportData;
}

/**
 * Initialize import/export feature.
 */
export function initImportExport(): void {
  // Set up drag and drop handlers
  const dropZone = getElementById<HTMLElement>('import-drop-zone');
  if (dropZone) {
    dropZone.addEventListener('dragover', handleDragOver as unknown as EventListener);
    dropZone.addEventListener('dragleave', handleDragLeave as unknown as EventListener);
    dropZone.addEventListener('drop', handleFileDrop as unknown as EventListener);
  }

  // Set up file input handler
  const fileInput = getElementById<HTMLInputElement>('import-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', handleFileSelect);
  }

  // Set up select all checkbox
  const selectAll = getElementById<HTMLInputElement>('import-select-all');
  if (selectAll) {
    selectAll.addEventListener('change', toggleAllImportPositions);
  }

  console.debug('Import/Export feature initialized');
}
