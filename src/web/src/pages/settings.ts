/**
 * Settings page module.
 * Handles AI providers, API keys, views, personal settings, and market assumptions.
 */

import { apiCall, ApiError } from '@/api/client';
import { showModal, closeModal } from '@/ui/modal';
import { showToast } from '@/ui/toast';
import { showLoading, hideLoading } from '@/ui/loading';
import { withSubmitGuard } from '@/ui/with-submit-guard';
import { emit } from '@/state/events';
import { onTabChange } from '@/ui/tabs';
import { formatCurrency } from '@/utils/format';
import { escapeHtml } from '@/utils/html';
import { store } from '@/state/store';
import { refreshData } from '@/pages/dashboard';
import { loadRetirementMetrics } from '@/pages/projections';
import { loadProfilesForSettings } from '@/features/profiles';
import { loadPlugins, loadInstalledPlugins, loadPluginSecurity } from '@/features/plugins';
import { loadEntities } from '@/features/entities';
import type { MerchantRuleResponse, SmartImportSettings } from '@/types/api';

/**
 * AI provider model from API.
 */
interface AIModel {
  id: string;
  display_name: string;
  is_default: boolean;
  context_length: number;
  capabilities: string[];
}

/**
 * AI provider from API.
 */
interface AIProvider {
  id: string;
  display_name: string;
  is_available: boolean;
  models: AIModel[];
}

/**
 * API key status from API.
 */
interface ApiKeyStatus {
  configured: boolean;
  source?: string;
}

/**
 * Account from API.
 */
interface Account {
  id: string;
  name: string;
  display_type: string;
  brokerage?: string;
  position_count?: number;
  value?: number;
  entity_id?: string | null;
}

/** Cached entities for account assignment. */
let entitiesCache: EntityResponse[] = [];

/**
 * View configuration from API.
 */
interface View {
  id: string;
  name: string;
  account_ids: string[];
  is_default: boolean;
}

/** Cached accounts for view management. */
let allAccountsCache: Account[] = [];

/** Cached AI providers. */
let aiProvidersData: AIProvider[] = [];

/**
 * Load AI providers and populate dropdowns.
 */
export async function loadAIProviders(): Promise<void> {
  try {
    const data = await apiCall<{ providers: AIProvider[] }>('/api/inference/providers');
    if (!data) {
      console.warn('Could not load AI providers');
      return;
    }

    aiProvidersData = data.providers || [];
    store.set('aiProviders', aiProvidersData);

    const providerSelect = document.getElementById(
      'ai-provider-select'
    ) as HTMLSelectElement | null;
    const modelSelect = document.getElementById('ai-model-select') as HTMLSelectElement | null;
    const statusEl = document.getElementById('ai-provider-status');

    if (!providerSelect || !modelSelect) return;

    // Get saved preferences from localStorage
    const savedProvider = localStorage.getItem('preferredAIProvider') || 'claude';
    const savedModel = localStorage.getItem('preferredAIModel') || '';

    // Populate provider dropdown
    providerSelect.textContent = '';
    aiProvidersData.forEach((p) => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.display_name + (p.is_available ? '' : ' (not configured)');
      if (p.id === savedProvider) option.selected = true;
      providerSelect.appendChild(option);
    });

    // Update model dropdown based on selected provider
    updateAIModelSelect(savedProvider, savedModel);

    // Update status message
    const currentProvider = aiProvidersData.find((p) => p.id === savedProvider);
    if (statusEl) {
      if (currentProvider?.is_available) {
        statusEl.textContent = `Connected to ${currentProvider.display_name}`;
        statusEl.className = 'form-help text-success';
      } else if (currentProvider) {
        statusEl.textContent = `${currentProvider.display_name} requires an API key. Add it in Data Sources above.`;
        statusEl.className = 'form-help text-warning';
      }
    }
  } catch (error) {
    console.error('Error loading AI providers:', error);
    const statusEl = document.getElementById('ai-provider-status');
    if (statusEl) {
      statusEl.textContent = 'Could not load AI providers';
      statusEl.className = 'form-help text-muted';
    }
  }
}

/**
 * Update AI model dropdown for selected provider.
 */
export function updateAIModelSelect(providerId: string, selectedModelId: string | null): void {
  const modelSelect = document.getElementById('ai-model-select') as HTMLSelectElement | null;
  const modelInfo = document.getElementById('ai-model-info');
  if (!modelSelect) return;

  const provider = aiProvidersData.find((p) => p.id === providerId);
  if (!provider || !provider.models || provider.models.length === 0) {
    modelSelect.textContent = '';
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No models available';
    modelSelect.appendChild(option);
    if (modelInfo) modelInfo.textContent = '';
    return;
  }

  // Populate models
  modelSelect.textContent = '';
  provider.models.forEach((m) => {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.display_name + (m.is_default ? ' (default)' : '');
    const selected =
      (selectedModelId && m.id === selectedModelId) || (!selectedModelId && m.is_default);
    if (selected) option.selected = true;
    modelSelect.appendChild(option);
  });

  // Update model info
  const currentModel = provider.models.find((m) =>
    selectedModelId ? m.id === selectedModelId : m.is_default
  );
  if (currentModel && modelInfo) {
    const capabilities = currentModel.capabilities.join(', ');
    modelInfo.textContent = `Context: ${(currentModel.context_length / 1000).toFixed(0)}K tokens | Supports: ${capabilities}`;
  }
}

/**
 * Handle AI provider change.
 */
export function onAIProviderChange(providerId: string): void {
  localStorage.setItem('preferredAIProvider', providerId);
  localStorage.removeItem('preferredAIModel');

  updateAIModelSelect(providerId, null);

  const statusEl = document.getElementById('ai-provider-status');
  const provider = aiProvidersData.find((p) => p.id === providerId);
  if (statusEl) {
    if (provider?.is_available) {
      statusEl.textContent = `Connected to ${provider.display_name}`;
      statusEl.className = 'form-help text-success';
    } else if (provider) {
      statusEl.textContent = `${provider.display_name} requires an API key. Add it in Data Sources above.`;
      statusEl.className = 'form-help text-warning';
    }
  }
}

/**
 * Handle AI model change.
 */
export function onAIModelChange(modelId: string): void {
  localStorage.setItem('preferredAIModel', modelId);

  const modelInfo = document.getElementById('ai-model-info');
  const providerId = localStorage.getItem('preferredAIProvider') || 'claude';
  const provider = aiProvidersData.find((p) => p.id === providerId);

  if (provider && modelInfo) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) {
      const capabilities = model.capabilities.join(', ');
      modelInfo.textContent = `Context: ${(model.context_length / 1000).toFixed(0)}K tokens | Supports: ${capabilities}`;
    }
  }
}

/**
 * Get current AI provider preferences.
 */
export function getAIPreferences(): { provider_id: string | null; model_id: string | null } {
  return {
    provider_id: localStorage.getItem('preferredAIProvider') || null,
    model_id: localStorage.getItem('preferredAIModel') || null,
  };
}

/**
 * Load accounts for management display.
 */
export async function loadAccountsManagement(): Promise<void> {
  try {
    // Fetch accounts and entities in parallel
    const [accounts, entities] = await Promise.all([
      apiCall<Account[]>('/api/portfolio/accounts'),
      apiCall<EntityResponse[]>('/api/entities/'),
    ]);

    // Cache entities for later use
    entitiesCache = entities || [];

    const tbody = document.getElementById('accounts-management-body');
    if (!tbody) return;

    tbody.textContent = '';

    if (!accounts || accounts.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'no-data';
      cell.textContent = 'No accounts found. Add your first account above.';
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }

    accounts.forEach((account) => {
      const row = document.createElement('tr');

      // Account info cell
      const infoCell = document.createElement('td');
      const infoDiv = document.createElement('div');
      infoDiv.className = 'account-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'account-name';
      nameSpan.textContent = account.name;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'account-meta';
      metaSpan.textContent = `${account.display_type} · ${account.brokerage || 'N/A'} · ${account.position_count || 0} positions`;

      infoDiv.appendChild(nameSpan);
      infoDiv.appendChild(metaSpan);
      infoCell.appendChild(infoDiv);

      // Owner cell with entity selector
      const ownerCell = document.createElement('td');
      const ownerSelect = document.createElement('select');
      ownerSelect.className = 'form-control form-control-sm entity-select';

      // Add "Unassigned" option
      const unassignedOption = document.createElement('option');
      unassignedOption.value = '';
      unassignedOption.textContent = '— Unassigned —';
      ownerSelect.appendChild(unassignedOption);

      // Add entity options (skip household entity)
      for (const entity of entitiesCache) {
        if (entity.is_household) continue;
        const option = document.createElement('option');
        option.value = entity.id;
        option.textContent = entity.name;
        option.style.color = entity.color;
        if (account.entity_id === entity.id) {
          option.selected = true;
        }
        ownerSelect.appendChild(option);
      }

      // Handle entity assignment change
      ownerSelect.addEventListener('change', () => {
        assignAccountToEntity(account.id, ownerSelect.value || null);
      });

      ownerCell.appendChild(ownerSelect);

      // Value cell
      const valueCell = document.createElement('td');
      valueCell.className = 'text-right';
      valueCell.textContent = formatCurrency(account.value || 0);

      // Actions cell
      const actionsCell = document.createElement('td');
      actionsCell.className = 'text-right';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-sm btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteAccount(account.id, account.name));

      actionsCell.appendChild(deleteBtn);

      row.appendChild(infoCell);
      row.appendChild(ownerCell);
      row.appendChild(valueCell);
      row.appendChild(actionsCell);
      tbody.appendChild(row);
    });
  } catch (error) {
    console.error('Error loading accounts for management:', error);
  }
}

/**
 * Assign an account to an entity.
 */
async function assignAccountToEntity(accountId: string, entityId: string | null): Promise<void> {
  try {
    await apiCall(`/api/entities/accounts/${accountId}/assign`, {
      method: 'POST',
      body: { entity_id: entityId },
    });
    showToast(entityId ? 'Account owner updated' : 'Account unassigned', 'success');
    // Reload entities list to update counts
    await loadEntitiesList();
  } catch (error) {
    console.error('Error assigning account to entity:', error);
    // Extract API error message for better user feedback
    const message = error instanceof ApiError ? error.message : 'Failed to update account owner';
    showToast(message, 'error');
    // Reload to reset the dropdown to previous value
    await loadAccountsManagement();
  }
}

/**
 * Delete an account.
 */
export async function deleteAccount(accountId: string, accountName: string): Promise<void> {
  const confirmed = confirm(
    `Are you sure you want to delete "${accountName}"?\n\n` +
      `This will permanently delete:\n` +
      `• The account\n` +
      `• All positions in this account\n\n` +
      `This action cannot be undone.`
  );

  if (!confirmed) return;

  const doubleConfirm = confirm(
    `FINAL CONFIRMATION\n\n` +
      `You are about to permanently delete "${accountName}" and all its data.\n\n` +
      `Click OK to proceed with deletion.`
  );

  if (!doubleConfirm) return;

  try {
    showLoading('Deleting account...');
    await apiCall(`/api/portfolio/accounts/${accountId}`, { method: 'DELETE' });

    showToast(`Account "${accountName}" deleted successfully`, 'success');
    await Promise.all([loadAccountsManagement(), refreshData(), loadViewsList()]);
    emit({ type: 'accounts:changed', reason: 'deleted' });
  } catch (error) {
    console.error('Error deleting account:', error);
    showToast('Failed to delete account', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Load API keys status.
 */
export async function loadApiKeysStatus(): Promise<void> {
  try {
    const data = await apiCall<{ api_keys: Record<string, ApiKeyStatus> }>(
      '/api/settings/api-keys/status'
    );
    const container = document.getElementById('api-keys-status');
    if (!container) return;

    const keyNames: Record<string, string> = {
      alpha_vantage: 'Alpha Vantage',
      massive: 'Massive',
      finnhub: 'Finnhub',
      anthropic_api_key: 'Anthropic (Claude)',
      gemini_api_key: 'Google Gemini',
      openai_api_key: 'OpenAI',
      cerebras_api_key: 'Cerebras',
      fmp_api_key: 'Financial Modeling Prep',
    };

    const keyDescriptions: Record<string, string> = {
      alpha_vantage: 'Stock prices & fundamentals',
      massive: 'Price data backup',
      finnhub: 'Real-time stock prices',
      anthropic_api_key: 'AI fund analysis & insights',
      gemini_api_key: 'AI fund analysis & insights',
      openai_api_key: 'AI fund analysis & insights',
      cerebras_api_key: 'AI fund analysis & insights',
      fmp_api_key: 'ETF sector weightings & fund data',
    };

    container.textContent = '';

    Object.entries(data.api_keys).forEach(([key, status]) => {
      const item = document.createElement('div');
      item.className = 'api-key-item';
      item.id = `api-key-${key}`;

      const icon = document.createElement('div');
      icon.className = `api-key-icon ${status.configured ? 'configured' : 'not-configured'}`;
      icon.textContent = status.configured ? '✓' : '○';

      const info = document.createElement('div');
      info.className = 'api-key-info';

      const name = document.createElement('div');
      name.className = 'api-key-name';
      name.textContent = keyNames[key] || key;

      const source = document.createElement('div');
      source.className = 'api-key-source';
      source.textContent = keyDescriptions[key] || '';

      info.appendChild(name);
      info.appendChild(source);

      const actions = document.createElement('div');
      actions.className = 'api-key-actions';

      const statusSpan = document.createElement('span');
      statusSpan.className = `api-key-status ${status.configured ? 'configured' : 'not-configured'}`;
      statusSpan.textContent = status.configured ? status.source || 'Configured' : 'Not set';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm btn-default';
      editBtn.textContent = status.configured ? 'Edit' : 'Add';
      editBtn.addEventListener('click', () => showApiKeyEditor(key, keyNames[key] || key));

      actions.appendChild(statusSpan);
      actions.appendChild(editBtn);

      item.appendChild(icon);
      item.appendChild(info);
      item.appendChild(actions);
      container.appendChild(item);
    });
  } catch (error) {
    console.error('Error loading API keys status:', error);
  }
}

/**
 * Show API key editor modal.
 */
export function showApiKeyEditor(keyId: string, keyName: string): void {
  const content = `
    <div class="api-key-editor">
      <p>Enter your ${escapeHtml(keyName)} API key. It will be securely stored in the database.</p>
      <div class="form-group">
        <label for="api-key-input">API Key</label>
        <input type="password" id="api-key-input" class="form-control" placeholder="Paste your API key here">
      </div>
      <div class="form-group" style="margin-top: 16px;">
        <label class="checkbox-label">
          <input type="checkbox" id="api-key-show">
          <span>Show key</span>
        </label>
      </div>
      <div class="modal-actions" style="margin-top: 20px; display: flex; gap: 12px; justify-content: flex-end;">
        <button class="btn btn-default" id="api-key-cancel">Cancel</button>
        <button class="btn btn-danger" id="api-key-delete" style="margin-right: auto;">Delete</button>
        <button class="btn btn-primary" id="api-key-save">Save Key</button>
      </div>
    </div>
  `;
  showModal(`Configure ${escapeHtml(keyName)}`, content);

  // Attach event handlers
  const showCheckbox = document.getElementById('api-key-show') as HTMLInputElement | null;
  const cancelBtn = document.getElementById('api-key-cancel');
  const deleteBtn = document.getElementById('api-key-delete');
  const saveBtn = document.getElementById('api-key-save');

  if (showCheckbox) {
    showCheckbox.addEventListener('change', toggleApiKeyVisibility);
  }
  if (cancelBtn) {
    cancelBtn.addEventListener('click', closeModal);
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => deleteApiKey(keyId));
  }
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveApiKey(keyId));
  }
}

/**
 * Toggle API key input visibility.
 */
export function toggleApiKeyVisibility(): void {
  const input = document.getElementById('api-key-input') as HTMLInputElement | null;
  const show = (document.getElementById('api-key-show') as HTMLInputElement | null)?.checked;
  if (input) {
    input.type = show ? 'text' : 'password';
  }
}

/**
 * Save API key.
 */
export async function saveApiKey(keyId: string): Promise<void> {
  const input = document.getElementById('api-key-input') as HTMLInputElement | null;
  const value = input?.value.trim();

  if (!value) {
    showToast('Please enter an API key', 'error');
    return;
  }

  try {
    await apiCall('/api/settings/api-key', {
      method: 'POST',
      body: { key: keyId, value: value },
    });

    showToast('API key saved successfully', 'success');
    closeModal();
    await loadApiKeysStatus();
  } catch (error) {
    console.error('Error saving API key:', error);
    showToast('Failed to save API key', 'error');
  }
}

/**
 * Delete API key.
 */
export async function deleteApiKey(keyId: string): Promise<void> {
  if (!confirm('Are you sure you want to delete this API key?')) {
    return;
  }

  try {
    await apiCall(`/api/settings/api-key/${keyId}`, { method: 'DELETE' });

    showToast('API key deleted', 'success');
    closeModal();
    await loadApiKeysStatus();
  } catch (error) {
    console.error('Error deleting API key:', error);
    showToast('Failed to delete API key', 'error');
  }
}

/**
 * Load views list for settings.
 */
export async function loadViewsList(): Promise<void> {
  try {
    const [views, accounts] = await Promise.all([
      apiCall<View[]>('/api/settings/views'),
      apiCall<Account[]>('/api/portfolio/accounts'),
    ]);

    allAccountsCache = accounts || [];
    store.set('availableViews', views || []);

    const container = document.getElementById('views-list');
    if (!container) return;

    container.textContent = '';

    if (!views || views.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-message';
      p.textContent = 'No views created yet.';
      container.appendChild(p);
      return;
    }

    views.forEach((view) => {
      const accountNames = view.account_ids
        .map((id) => accounts?.find((a) => a.id === id))
        .filter((a) => a)
        .map((a) => a!.name)
        .slice(0, 3);
      const moreCount = view.account_ids.length - accountNames.length;

      const item = document.createElement('div');
      item.className = 'view-item' + (view.is_default ? ' is-default' : '');

      const info = document.createElement('div');
      info.className = 'view-info';

      const nameDiv = document.createElement('div');
      nameDiv.className = 'view-name';
      nameDiv.textContent = view.name;
      if (view.is_default) {
        const badge = document.createElement('span');
        badge.className = 'default-badge';
        badge.textContent = 'Default';
        nameDiv.appendChild(badge);
      }

      const accountsDiv = document.createElement('div');
      accountsDiv.className = 'view-accounts';
      accountsDiv.textContent =
        accountNames.join(', ') + (moreCount > 0 ? ` +${moreCount} more` : '');

      info.appendChild(nameDiv);
      info.appendChild(accountsDiv);

      const actions = document.createElement('div');
      actions.className = 'view-actions';

      if (view.name !== 'All Accounts') {
        const editBtn = document.createElement('button');
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => editView(view.id));
        actions.appendChild(editBtn);

        if (!view.is_default) {
          const setDefaultBtn = document.createElement('button');
          setDefaultBtn.textContent = 'Set Default';
          setDefaultBtn.addEventListener('click', () => setDefaultView(view.id));
          actions.appendChild(setDefaultBtn);
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'danger';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => deleteView(view.id));
        actions.appendChild(deleteBtn);
      }

      item.appendChild(info);
      item.appendChild(actions);
      container.appendChild(item);
    });
  } catch (error) {
    console.error('Error loading views:', error);
  }
}

/**
 * Show create view modal.
 */
export function showCreateViewModal(): void {
  const titleEl = document.getElementById('view-modal-title');
  const editIdEl = document.getElementById('view-edit-id') as HTMLInputElement | null;
  const nameEl = document.getElementById('view-name') as HTMLInputElement | null;
  const defaultEl = document.getElementById('view-is-default') as HTMLInputElement | null;
  const listContainer = document.getElementById('view-accounts-list');

  if (titleEl) titleEl.textContent = 'Create Portfolio View';
  if (editIdEl) editIdEl.value = '';
  if (nameEl) nameEl.value = '';
  if (defaultEl) defaultEl.checked = false;

  // Populate accounts checkboxes
  if (listContainer) {
    listContainer.textContent = '';
    allAccountsCache.forEach((acc) => {
      const label = document.createElement('label');
      label.className = 'checkbox-label';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'view-account';
      checkbox.value = acc.id;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = acc.name;

      const typeSpan = document.createElement('span');
      typeSpan.className = 'account-type';
      typeSpan.textContent = acc.display_type;

      label.appendChild(checkbox);
      label.appendChild(nameSpan);
      label.appendChild(typeSpan);
      listContainer.appendChild(label);
    });
  }

  const modal = document.getElementById('view-modal');
  if (modal) {
    // `hidden` is `display:none !important`; strip it so the modal shows.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
}

/**
 * Edit existing view.
 */
export function editView(viewId: string): void {
  const views = store.get('availableViews') || [];
  const view = views.find((v) => v.id === viewId);
  if (!view) return;

  const titleEl = document.getElementById('view-modal-title');
  const editIdEl = document.getElementById('view-edit-id') as HTMLInputElement | null;
  const nameEl = document.getElementById('view-name') as HTMLInputElement | null;
  const defaultEl = document.getElementById('view-is-default') as HTMLInputElement | null;
  const listContainer = document.getElementById('view-accounts-list');

  if (titleEl) titleEl.textContent = 'Edit Portfolio View';
  if (editIdEl) editIdEl.value = viewId;
  if (nameEl) nameEl.value = view.name;
  if (defaultEl) defaultEl.checked = view.is_default ?? false;

  // Populate accounts checkboxes with current selections
  if (listContainer) {
    listContainer.textContent = '';
    allAccountsCache.forEach((acc) => {
      const label = document.createElement('label');
      label.className = 'checkbox-label';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'view-account';
      checkbox.value = acc.id;
      if (view.account_ids.includes(acc.id)) checkbox.checked = true;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = acc.name;

      const typeSpan = document.createElement('span');
      typeSpan.className = 'account-type';
      typeSpan.textContent = acc.display_type;

      label.appendChild(checkbox);
      label.appendChild(nameSpan);
      label.appendChild(typeSpan);
      listContainer.appendChild(label);
    });
  }

  const modal = document.getElementById('view-modal');
  if (modal) {
    // `hidden` is `display:none !important`; strip it so the modal shows.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
}

/**
 * Hide view modal.
 */
export function hideViewModal(): void {
  const modal = document.getElementById('view-modal');
  if (modal) modal.style.display = 'none';
}

/**
 * Save view (create or update).
 */
export async function saveView(event: Event): Promise<void> {
  event.preventDefault();

  const editId = (document.getElementById('view-edit-id') as HTMLInputElement | null)?.value;
  const name = (document.getElementById('view-name') as HTMLInputElement | null)?.value;
  const isDefault = (document.getElementById('view-is-default') as HTMLInputElement | null)
    ?.checked;

  // Get selected account IDs
  const checkboxes = document.querySelectorAll<HTMLInputElement>(
    'input[name="view-account"]:checked'
  );
  const accountIds = Array.from(checkboxes).map((cb) => cb.value);

  if (accountIds.length === 0) {
    showToast('Please select at least one account', 'error');
    return;
  }

  try {
    const url = editId ? `/api/settings/views/${editId}` : '/api/settings/views';
    const method = editId ? 'PUT' : 'POST';

    await apiCall(url, {
      method,
      body: { name, account_ids: accountIds, is_default: isDefault },
    });

    showToast(editId ? 'View updated' : 'View created', 'success');
    hideViewModal();
    await loadViewsList();
  } catch {
    showToast('Failed to save view', 'error');
  }
}

/**
 * Set view as default.
 */
export async function setDefaultView(viewId: string): Promise<void> {
  try {
    await apiCall(`/api/settings/views/${viewId}/set-default`, { method: 'PUT' });

    showToast('Default view updated', 'success');
    await loadViewsList();
  } catch {
    showToast('Failed to set default view', 'error');
  }
}

/**
 * Delete view.
 */
export async function deleteView(viewId: string): Promise<void> {
  if (!confirm('Delete this view?')) return;

  try {
    await apiCall(`/api/settings/views/${viewId}`, { method: 'DELETE' });

    showToast('View deleted', 'success');
    await loadViewsList();

    // If we deleted the current view, reset to default
    const currentViewId = store.get('currentViewId');
    if (currentViewId === viewId) {
      store.set('currentViewId', null);
      localStorage.removeItem('portfolioViewId');
      refreshData();
    }
  } catch {
    showToast('Failed to delete view', 'error');
  }
}

// =============================================================================
// Entity Management
// =============================================================================

interface EntityResponse {
  id: string;
  name: string;
  entity_type: string;
  is_default: boolean;
  is_household: boolean;
  color: string;
  icon: string;
  account_count: number;
  income_count: number;
  expense_count: number;
}

/**
 * Create an entity item element using safe DOM methods.
 */
function createEntityItem(entity: EntityResponse): HTMLElement {
  const isHousehold = entity.is_household;

  const item = document.createElement('div');
  item.className = 'entity-item';
  if (entity.is_default) item.classList.add('is-default');
  if (isHousehold) item.classList.add('is-household');

  // Color indicator
  const colorIndicator = document.createElement('div');
  colorIndicator.className = 'entity-color-indicator';
  colorIndicator.style.backgroundColor = entity.color;
  item.appendChild(colorIndicator);

  // Info section
  const info = document.createElement('div');
  info.className = 'entity-info';

  const nameDiv = document.createElement('div');
  nameDiv.className = 'entity-name';
  nameDiv.appendChild(document.createTextNode(entity.name));

  if (entity.is_default) {
    const defaultBadge = document.createElement('span');
    defaultBadge.className = 'default-badge';
    defaultBadge.textContent = 'Default';
    nameDiv.appendChild(defaultBadge);
  }

  if (isHousehold) {
    const householdBadge = document.createElement('span');
    householdBadge.className = 'household-badge';
    householdBadge.textContent = 'Household';
    nameDiv.appendChild(householdBadge);
  } else {
    const typeBadge = document.createElement('span');
    typeBadge.className = 'entity-type-badge';
    typeBadge.textContent = entity.entity_type;
    nameDiv.appendChild(typeBadge);
  }

  info.appendChild(nameDiv);

  const details = document.createElement('div');
  details.className = 'entity-details';
  const counts: string[] = [];
  if (entity.account_count > 0)
    counts.push(`${entity.account_count} account${entity.account_count !== 1 ? 's' : ''}`);
  if (entity.income_count > 0)
    counts.push(`${entity.income_count} income source${entity.income_count !== 1 ? 's' : ''}`);
  details.textContent = counts.length > 0 ? counts.join(', ') : 'No accounts assigned';
  info.appendChild(details);

  item.appendChild(info);

  // Actions
  if (!isHousehold) {
    const actions = document.createElement('div');
    actions.className = 'entity-actions';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => editEntity(entity.id));
    actions.appendChild(editBtn);

    if (!entity.is_default) {
      const setDefaultBtn = document.createElement('button');
      setDefaultBtn.textContent = 'Set Default';
      setDefaultBtn.addEventListener('click', () => setDefaultEntity(entity.id));
      actions.appendChild(setDefaultBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteEntity(entity.id));
    actions.appendChild(deleteBtn);

    item.appendChild(actions);
  }

  return item;
}

/**
 * Load entities list for settings.
 */
export async function loadEntitiesList(): Promise<void> {
  try {
    const entities = await apiCall<EntityResponse[]>('/api/entities/');
    const container = document.getElementById('entities-list');
    if (!container) return;

    // Clear existing content
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    if (entities.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'text-muted';
      emptyMsg.textContent =
        'No entities configured. Click "Auto-Detect" to create entities from your account names, or click "New Entity" to create one manually.';
      container.appendChild(emptyMsg);
      return;
    }

    for (const entity of entities) {
      container.appendChild(createEntityItem(entity));
    }
  } catch (error) {
    console.error('Error loading entities:', error);
    const container = document.getElementById('entities-list');
    if (container) {
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      const errorMsg = document.createElement('p');
      errorMsg.className = 'text-error';
      errorMsg.textContent = 'Failed to load entities';
      container.appendChild(errorMsg);
    }
  }
}

/**
 * Show create entity modal.
 */
export function showCreateEntityModal(): void {
  const modal = document.getElementById('entity-modal');
  const title = document.getElementById('entity-modal-title');
  const editId = document.getElementById('entity-edit-id') as HTMLInputElement;
  const nameInput = document.getElementById('entity-name') as HTMLInputElement;
  const typeSelect = document.getElementById('entity-type') as HTMLSelectElement;
  const colorInput = document.getElementById('entity-color') as HTMLInputElement;
  const defaultCheckbox = document.getElementById('entity-is-default') as HTMLInputElement;

  if (!modal || !title || !editId) return;

  title.textContent = 'Create Entity';
  editId.value = '';
  if (nameInput) nameInput.value = '';
  if (typeSelect) typeSelect.value = 'individual';
  if (colorInput) colorInput.value = '#4A90D9';
  if (defaultCheckbox) defaultCheckbox.checked = false;

  // `hidden` is `display:none !important`; strip it so the modal shows.
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

/**
 * Hide entity modal.
 */
export function hideEntityModal(): void {
  const modal = document.getElementById('entity-modal');
  if (modal) {
    modal.style.display = 'none';
  }
}

/**
 * Edit entity.
 */
export async function editEntity(entityId: string): Promise<void> {
  try {
    const entity = await apiCall<EntityResponse>(`/api/entities/${entityId}`);

    const modal = document.getElementById('entity-modal');
    const title = document.getElementById('entity-modal-title');
    const editId = document.getElementById('entity-edit-id') as HTMLInputElement;
    const nameInput = document.getElementById('entity-name') as HTMLInputElement;
    const typeSelect = document.getElementById('entity-type') as HTMLSelectElement;
    const colorInput = document.getElementById('entity-color') as HTMLInputElement;
    const defaultCheckbox = document.getElementById('entity-is-default') as HTMLInputElement;

    if (!modal || !title || !editId) return;

    title.textContent = 'Edit Entity';
    editId.value = entityId;
    if (nameInput) nameInput.value = entity.name;
    if (typeSelect) typeSelect.value = entity.entity_type;
    if (colorInput) colorInput.value = entity.color;
    if (defaultCheckbox) defaultCheckbox.checked = entity.is_default;

    // `hidden` is `display:none !important`; strip it so the modal shows.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  } catch {
    showToast('Failed to load entity', 'error');
  }
}

/**
 * Save entity (create or update).
 */
export async function saveEntity(event: Event): Promise<void> {
  event.preventDefault();

  const editId = (document.getElementById('entity-edit-id') as HTMLInputElement)?.value;
  const name = (document.getElementById('entity-name') as HTMLInputElement)?.value;
  const entityType = (document.getElementById('entity-type') as HTMLSelectElement)?.value;
  const color = (document.getElementById('entity-color') as HTMLInputElement)?.value;
  const isDefault = (document.getElementById('entity-is-default') as HTMLInputElement)?.checked;

  if (!name) {
    showToast('Entity name is required', 'error');
    return;
  }

  const data = {
    name,
    entity_type: entityType,
    color,
    is_default: isDefault,
  };

  try {
    if (editId) {
      await apiCall(`/api/entities/${editId}`, {
        method: 'PUT',
        body: data,
      });
      showToast('Entity updated', 'success');
    } else {
      await apiCall('/api/entities/', {
        method: 'POST',
        body: data,
      });
      showToast('Entity created', 'success');
    }
    hideEntityModal();
    await loadEntitiesList();
    // Reload entity selector in sidebar
    await loadEntities();
  } catch {
    showToast('Failed to save entity', 'error');
  }
}

/**
 * Set default entity.
 */
export async function setDefaultEntity(entityId: string): Promise<void> {
  try {
    await apiCall(`/api/entities/${entityId}`, {
      method: 'PUT',
      body: { is_default: true },
    });
    showToast('Default entity updated', 'success');
    await loadEntitiesList();
  } catch {
    showToast('Failed to set default entity', 'error');
  }
}

/**
 * Delete entity.
 */
export async function deleteEntity(entityId: string): Promise<void> {
  if (!confirm('Delete this entity? Accounts assigned to this entity will become unassigned.'))
    return;

  try {
    await apiCall(`/api/entities/${entityId}`, { method: 'DELETE' });
    showToast('Entity deleted', 'success');
    await loadEntitiesList();
    // Reload entity selector in sidebar
    await loadEntities();
  } catch {
    showToast('Failed to delete entity', 'error');
  }
}

/**
 * Run auto-detect entities from account names.
 */
export async function runAutoDetectEntities(): Promise<void> {
  try {
    const result = await apiCall<{
      success: boolean;
      entities_created: string[];
      accounts_assigned: number;
      income_sources_assigned: number;
    }>('/api/entities/auto-detect', { method: 'POST' });

    if (result.entities_created.length > 0) {
      showToast(
        `Created ${result.entities_created.length} entities: ${result.entities_created.join(', ')}`,
        'success'
      );
    } else {
      showToast('No new entities detected from account names', 'info');
    }

    await loadEntitiesList();
    // Reload entity selector in sidebar
    await loadEntities();
  } catch {
    showToast('Failed to auto-detect entities', 'error');
  }
}

/**
 * Save personal settings.
 */
export async function savePersonalSettings(event: Event): Promise<void> {
  event.preventDefault();

  const form = event.target as HTMLFormElement | null;
  const submitBtn = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;

  const withdrawalRate = parseInt(
    (document.getElementById('settings-withdrawal-rate') as HTMLInputElement | null)?.value || '4'
  );
  if (isNaN(withdrawalRate) || withdrawalRate < 1 || withdrawalRate > 100) {
    showToast('Withdrawal rate must be between 1 and 100', 'error');
    return;
  }

  const data = {
    dob: (document.getElementById('settings-dob') as HTMLInputElement | null)?.value,
    retirement_age: parseInt(
      (document.getElementById('settings-retirement-age') as HTMLInputElement | null)?.value || '65'
    ),
    withdrawal_rate: withdrawalRate,
    target_monthly_income: parseFloat(
      (document.getElementById('settings-target-income') as HTMLInputElement | null)?.value || '0'
    ),
    ss_claiming_age: parseInt(
      (document.getElementById('settings-ss-claiming-age') as HTMLInputElement | null)?.value ||
        '67'
    ),
  };

  try {
    await withSubmitGuard(submitBtn, 'Saving...', () =>
      apiCall('/api/settings/config/personal', {
        method: 'PUT',
        body: data,
      })
    );
    showToast('Personal settings saved', 'success');
    await loadRetirementMetrics();

    // Notify other pages to update age fields from the new settings.
    // Legacy event kept for the listener in main.ts; typed bus is additive.
    document.dispatchEvent(new CustomEvent('settings:personalUpdated'));
  } catch {
    showToast('Failed to save settings', 'error');
  }
}

/**
 * Save asset class targets.
 */
export async function saveAssetClassTargets(event: Event): Promise<void> {
  event.preventDefault();

  const data = {
    equities:
      parseFloat(
        (document.getElementById('target-equities') as HTMLInputElement | null)?.value || '60'
      ) / 100,
    bonds:
      parseFloat(
        (document.getElementById('target-bonds') as HTMLInputElement | null)?.value || '30'
      ) / 100,
    alternatives:
      parseFloat(
        (document.getElementById('target-alternatives') as HTMLInputElement | null)?.value || '5'
      ) / 100,
    cash:
      parseFloat(
        (document.getElementById('target-cash') as HTMLInputElement | null)?.value || '5'
      ) / 100,
  };

  try {
    await apiCall('/api/settings/config/targets/asset_class', {
      method: 'PUT',
      body: data,
    });
    showToast('Asset targets saved', 'success');
  } catch {
    showToast('Failed to save targets', 'error');
  }
}

/**
 * Load personal settings from API and populate form.
 */
export async function loadPersonalSettings(): Promise<void> {
  try {
    const data = await apiCall<{
      personal?: {
        dob?: string;
        retirement_age?: number;
        withdrawal_rate?: number;
        target_monthly_income?: number;
        ss_claiming_age?: number;
      };
    }>('/api/settings/config/personal');

    if (!data?.personal) return;

    const p = data.personal;

    const dob = document.getElementById('settings-dob') as HTMLInputElement | null;
    if (dob && p.dob) dob.value = p.dob;

    const retirementAge = document.getElementById(
      'settings-retirement-age'
    ) as HTMLInputElement | null;
    if (retirementAge && p.retirement_age) retirementAge.value = String(p.retirement_age);

    const withdrawalRate = document.getElementById(
      'settings-withdrawal-rate'
    ) as HTMLInputElement | null;
    if (withdrawalRate && p.withdrawal_rate) withdrawalRate.value = String(p.withdrawal_rate);

    const targetIncome = document.getElementById(
      'settings-target-income'
    ) as HTMLInputElement | null;
    if (targetIncome && p.target_monthly_income != null)
      targetIncome.value = String(p.target_monthly_income);

    const ssClaimingAge = document.getElementById(
      'settings-ss-claiming-age'
    ) as HTMLInputElement | null;
    if (ssClaimingAge && p.ss_claiming_age != null) ssClaimingAge.value = String(p.ss_claiming_age);
  } catch (error) {
    console.error('Error loading personal settings:', error);
  }
}

/**
 * Load asset class targets from API and populate form.
 */
export async function loadAssetClassTargets(): Promise<void> {
  try {
    const data = await apiCall<{
      targets?: {
        asset_class?: {
          equities?: number;
          bonds?: number;
          alternatives?: number;
          cash?: number;
        };
      };
    }>('/api/settings/config/targets');

    if (!data?.targets?.asset_class) return;

    const t = data.targets.asset_class;

    const equities = document.getElementById('target-equities') as HTMLInputElement | null;
    if (equities && t.equities != null) equities.value = String(t.equities * 100);

    const bonds = document.getElementById('target-bonds') as HTMLInputElement | null;
    if (bonds && t.bonds != null) bonds.value = String(t.bonds * 100);

    const alternatives = document.getElementById('target-alternatives') as HTMLInputElement | null;
    if (alternatives && t.alternatives != null) alternatives.value = String(t.alternatives * 100);

    const cash = document.getElementById('target-cash') as HTMLInputElement | null;
    if (cash && t.cash != null) cash.value = String(t.cash * 100);
  } catch (error) {
    console.error('Error loading asset class targets:', error);
  }
}

/**
 * Load market assumptions from API and populate form.
 */
export async function loadMarketAssumptions(): Promise<void> {
  try {
    const data = await apiCall<{
      market: {
        stock_mean_return: number;
        stock_std_dev: number;
        bond_mean_return: number;
        bond_std_dev: number;
        inflation_rate: number;
        risk_free_rate: number;
      };
    }>('/api/settings/config/market');

    if (!data?.market) return;

    const m = data.market;

    const stockReturn = document.getElementById('market-stock-return') as HTMLInputElement | null;
    if (stockReturn) stockReturn.value = String(m.stock_mean_return * 100);

    const stockStd = document.getElementById('market-stock-std') as HTMLInputElement | null;
    if (stockStd) stockStd.value = String(m.stock_std_dev * 100);

    const bondReturn = document.getElementById('market-bond-return') as HTMLInputElement | null;
    if (bondReturn) bondReturn.value = String(m.bond_mean_return * 100);

    const bondStd = document.getElementById('market-bond-std') as HTMLInputElement | null;
    if (bondStd) bondStd.value = String(m.bond_std_dev * 100);

    const inflation = document.getElementById('market-inflation') as HTMLInputElement | null;
    if (inflation) inflation.value = String(m.inflation_rate * 100);

    const riskFree = document.getElementById('market-risk-free') as HTMLInputElement | null;
    if (riskFree) riskFree.value = String(m.risk_free_rate * 100);
  } catch (error) {
    console.error('Error loading market assumptions:', error);
  }
}

/**
 * Save market assumptions.
 */
export async function saveMarketAssumptions(event: Event): Promise<void> {
  event.preventDefault();

  const data = {
    stock_mean_return:
      parseFloat(
        (document.getElementById('market-stock-return') as HTMLInputElement | null)?.value || '7'
      ) / 100,
    stock_std_dev:
      parseFloat(
        (document.getElementById('market-stock-std') as HTMLInputElement | null)?.value || '15'
      ) / 100,
    bond_mean_return:
      parseFloat(
        (document.getElementById('market-bond-return') as HTMLInputElement | null)?.value || '3'
      ) / 100,
    bond_std_dev:
      parseFloat(
        (document.getElementById('market-bond-std') as HTMLInputElement | null)?.value || '5'
      ) / 100,
    stock_bond_correlation: -0.2,
    inflation_rate:
      parseFloat(
        (document.getElementById('market-inflation') as HTMLInputElement | null)?.value || '3'
      ) / 100,
    risk_free_rate:
      parseFloat(
        (document.getElementById('market-risk-free') as HTMLInputElement | null)?.value || '2'
      ) / 100,
  };

  try {
    await apiCall('/api/settings/config/market', {
      method: 'PUT',
      body: data,
    });
    showToast('Market assumptions saved', 'success');
  } catch {
    showToast('Failed to save assumptions', 'error');
  }
}

/**
 * Save Monte Carlo settings.
 */
export async function saveMonteCarloSettings(event: Event): Promise<void> {
  event.preventDefault();

  const data = {
    num_simulations: parseInt(
      (document.getElementById('mc-simulations') as HTMLInputElement | null)?.value || '1000'
    ),
    black_swan_probability:
      parseFloat(
        (document.getElementById('mc-black-swan-prob') as HTMLInputElement | null)?.value || '5'
      ) / 100,
    black_swan_impact:
      parseFloat(
        (document.getElementById('mc-black-swan-impact') as HTMLInputElement | null)?.value || '30'
      ) / 100,
    golden_swan_probability:
      parseFloat(
        (document.getElementById('mc-golden-swan-prob') as HTMLInputElement | null)?.value || '3'
      ) / 100,
    golden_swan_impact:
      parseFloat(
        (document.getElementById('mc-golden-swan-impact') as HTMLInputElement | null)?.value || '25'
      ) / 100,
    t_distribution_df: 5,
  };

  try {
    await apiCall('/api/settings/config/monte_carlo', {
      method: 'PUT',
      body: data,
    });
    showToast('Monte Carlo settings saved', 'success');
  } catch {
    showToast('Failed to save settings', 'error');
  }
}

/**
 * Load Monte Carlo settings from API and populate form.
 */
export async function loadMonteCarloSettings(): Promise<void> {
  try {
    const data = await apiCall<{
      monte_carlo: {
        num_simulations: number;
        black_swan_probability: number;
        black_swan_impact: number;
        golden_swan_probability: number;
        golden_swan_impact: number;
      };
    }>('/api/settings/config/monte_carlo');

    if (!data?.monte_carlo) return;

    const mc = data.monte_carlo;

    const simInput = document.getElementById('mc-simulations') as HTMLInputElement | null;
    if (simInput) simInput.value = String(mc.num_simulations);

    const bsProb = document.getElementById('mc-black-swan-prob') as HTMLInputElement | null;
    if (bsProb) bsProb.value = String(mc.black_swan_probability * 100);

    const bsImpact = document.getElementById('mc-black-swan-impact') as HTMLInputElement | null;
    if (bsImpact) bsImpact.value = String(mc.black_swan_impact * 100);

    const gsProb = document.getElementById('mc-golden-swan-prob') as HTMLInputElement | null;
    if (gsProb) gsProb.value = String(mc.golden_swan_probability * 100);

    const gsImpact = document.getElementById('mc-golden-swan-impact') as HTMLInputElement | null;
    if (gsImpact) gsImpact.value = String(mc.golden_swan_impact * 100);
  } catch (error) {
    console.error('Error loading Monte Carlo settings:', error);
  }
}

const SI = '/api/smart-import';
const siEl = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function siSave(
  patch: Partial<SmartImportSettings>,
  undo: () => void,
  done: string
): Promise<void> {
  try {
    await apiCall(`${SI}/settings`, { method: 'PUT', body: patch });
    showToast(done, 'success');
  } catch {
    undo();
    showToast('Could not save the setting', 'error');
  }
}

async function siDeleteRule(id: string): Promise<void> {
  if (!confirm('Forget this merchant? Future imports will no longer apply its category.')) return;
  try {
    await apiCall(`${SI}/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Remembered merchant deleted', 'success');
  } catch {
    showToast('Could not delete the merchant', 'error');
  }
  await siLoadRules();
}

function siRuleRow(rule: MerchantRuleResponse): HTMLElement {
  const li = document.createElement('li');
  li.className = 'si-rule';
  const key = document.createElement('span');
  key.className = 'si-rule-key';
  key.textContent = rule.merchant_key;
  const cat = document.createElement('span');
  cat.className = 'si-rule-cat' + (rule.category_deleted ? ' is-deleted' : '');
  cat.textContent = rule.category_deleted
    ? 'category deleted'
    : (rule.category_name ?? rule.kind ?? '');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-secondary btn-sm';
  btn.textContent = 'Delete';
  btn.setAttribute('aria-label', `Delete remembered merchant ${rule.merchant_key}`);
  btn.addEventListener('click', () => void siDeleteRule(rule.id));
  li.append(key, cat, btn);
  return li;
}

async function siLoadRules(): Promise<void> {
  const list = siEl('si-rules-list');
  let rules: MerchantRuleResponse[] = [];
  try {
    rules = await apiCall<MerchantRuleResponse[]>(`${SI}/rules`);
  } catch {
    list.replaceChildren(
      Object.assign(document.createElement('li'), {
        textContent: 'Could not load remembered merchants.',
      })
    );
    return;
  }
  if (!rules.length) {
    list.replaceChildren(
      Object.assign(document.createElement('li'), {
        className: 'si-empty',
        textContent: 'No remembered merchants yet.',
      })
    );
    return;
  }
  list.replaceChildren(...rules.map(siRuleRow));
}

async function siDeleteAll(): Promise<void> {
  if (
    !confirm('Delete all imported transactions? Imports, expenses and remembered merchants stay.')
  )
    return;
  const status = siEl('si-delete-status');
  try {
    const r = await apiCall<{ deleted: number }>(`${SI}/transactions`, { method: 'DELETE' });
    const msg = `Deleted ${r.deleted} imported transaction${r.deleted === 1 ? '' : 's'}.`;
    status.textContent = msg;
    showToast(msg, 'success');
  } catch {
    status.textContent = '';
    showToast('Could not delete imported transactions', 'error');
  }
}

/** Fill the Imported transactions section; the AI toggles exist in server mode only. */
export async function loadSmartImportSettings(): Promise<void> {
  const retention = siEl<HTMLSelectElement>('si-retention');
  if (!retention) return;
  const hosted = store.get('dataMode') === 'local';
  siEl('si-ai-group').classList.toggle('hidden', hosted);
  const boxes = {
    ai_enabled: siEl<HTMLInputElement>('si-ai-enabled'),
    pdf_ai_enabled: siEl<HTMLInputElement>('si-pdf-ai-enabled'),
  };
  try {
    const s = await apiCall<SmartImportSettings>(`${SI}/settings`);
    retention.value = String(s.retention_months);
    boxes.ai_enabled.checked = s.ai_enabled;
    boxes.pdf_ai_enabled.checked = s.pdf_ai_enabled;
  } catch {
    showToast('Could not load import settings', 'error');
  }
  if (!retention.dataset.bound) {
    retention.dataset.bound = '1';
    let last = retention.value;
    retention.addEventListener('change', () => {
      const prev = last;
      last = retention.value;
      void siSave(
        { retention_months: Number(retention.value) as SmartImportSettings['retention_months'] },
        () => {
          retention.value = prev;
          last = prev;
        },
        'Retention saved'
      );
    });
    (Object.keys(boxes) as (keyof typeof boxes)[]).forEach((k) =>
      boxes[k].addEventListener(
        'change',
        () =>
          void siSave(
            { [k]: boxes[k].checked },
            () => {
              boxes[k].checked = !boxes[k].checked;
            },
            'Setting saved'
          )
      )
    );
    siEl('si-delete-all').addEventListener('click', () => void siDeleteAll());
  }
  await siLoadRules();
}

/**
 * Initialize settings page.
 */
export function initSettings(): void {
  // AI provider/model dropdowns
  const providerSelect = document.getElementById('ai-provider-select');
  if (providerSelect) {
    providerSelect.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      onAIProviderChange(target.value);
    });
  }

  const modelSelect = document.getElementById('ai-model-select');
  if (modelSelect) {
    modelSelect.addEventListener('change', (e) => {
      const target = e.target as HTMLSelectElement;
      onAIModelChange(target.value);
    });
  }

  // Personal settings form
  const personalForm = document.getElementById('personal-settings-form');
  if (personalForm) {
    personalForm.addEventListener('submit', savePersonalSettings);
  }

  // Asset targets form
  const assetForm = document.getElementById('asset-targets-form');
  if (assetForm) {
    assetForm.addEventListener('submit', saveAssetClassTargets);
  }

  // Market assumptions form
  const marketForm = document.getElementById('market-assumptions-form');
  if (marketForm) {
    marketForm.addEventListener('submit', saveMarketAssumptions);
  }

  // Monte Carlo settings form
  const mcForm = document.getElementById('monte-carlo-settings-form');
  if (mcForm) {
    mcForm.addEventListener('submit', saveMonteCarloSettings);
  }

  // View modal — the form uses the inline onsubmit="" handler in index.html;
  // do not also bind here, or the submit fires twice.
  const createViewBtn = document.getElementById('create-view-btn');
  if (createViewBtn) {
    createViewBtn.addEventListener('click', showCreateViewModal);
  }

  const viewModalClose = document.getElementById('view-modal-close');
  if (viewModalClose) {
    viewModalClose.addEventListener('click', hideViewModal);
  }

  // Load all settings data when switching to settings tab
  onTabChange((tab) => {
    if (tab === 'settings') {
      loadAccountsManagement();
      loadProfilesForSettings();
      loadApiKeysStatus();
      loadAIProviders();
      loadViewsList();
      loadEntitiesList();
      loadPersonalSettings();
      loadAssetClassTargets();
      loadMarketAssumptions();
      loadMonteCarloSettings();
      void loadSmartImportSettings();
      loadPlugins();
      loadInstalledPlugins();
      loadPluginSecurity();
    }
  });
}
