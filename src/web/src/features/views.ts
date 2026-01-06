/**
 * Portfolio views feature module.
 * Handles loading, selecting, and managing portfolio views for filtered dashboard views.
 */

import { apiCall } from '@/api/client';
import { store } from '@/state/store';
import { showToast } from '@/ui/toast';
import { refreshData } from '@/pages/dashboard';
import type { PortfolioView } from '@/types/api';

/**
 * Load portfolio views from the API and populate the view selector.
 *
 * @returns true if views loaded successfully, false on error
 */
export async function loadViews(): Promise<boolean> {
  try {
    const views = await apiCall<PortfolioView[]>('/api/settings/views');
    store.set('availableViews', views);
    populateViewSelector(views);
    return true;
  } catch (error) {
    console.error('Error loading views:', error);
    store.set('availableViews', []);
    showToast('Unable to load portfolio views', 'warning');
    return false;
  }
}

/**
 * Populate the view selector dropdown with available views.
 */
export function populateViewSelector(views: PortfolioView[]): void {
  const selector = document.getElementById('view-selector') as HTMLSelectElement;
  if (!selector) return;

  // Preserve current selection
  const currentViewId = store.get('currentViewId');

  // Clear existing options
  while (selector.firstChild) {
    selector.removeChild(selector.firstChild);
  }

  // Add default "All Accounts" option
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'All Accounts';
  selector.appendChild(defaultOption);

  // Add view options
  for (const view of views) {
    // Skip the "All Accounts" default view as it's already added
    if (view.name === 'All Accounts') continue;

    const option = document.createElement('option');
    option.value = view.id;
    option.textContent = view.name;

    if (view.id === currentViewId) {
      option.selected = true;
    }

    selector.appendChild(option);
  }

  // If we have a current view that's not in the list, reset to default
  if (currentViewId && !views.some((v) => v.id === currentViewId)) {
    store.set('currentViewId', null);
    localStorage.removeItem('portfolioViewId');
  }
}

/**
 * Change the current portfolio view filter.
 * Updates state, persists to localStorage, and refreshes dashboard data.
 */
export async function changeView(viewId: string): Promise<void> {
  // Handle empty string as null (All Accounts)
  const newViewId = viewId || null;

  // Update store
  store.set('currentViewId', newViewId);

  // Persist to localStorage
  if (newViewId) {
    localStorage.setItem('portfolioViewId', newViewId);
  } else {
    localStorage.removeItem('portfolioViewId');
  }

  // Get view name for toast messages
  const views = store.get('availableViews');
  const view = views.find((v) => v.id === newViewId);
  const name = view ? view.name : 'All Accounts';

  // Refresh dashboard with new view filter
  try {
    await refreshData();
    showToast(`View: ${name}`, 'success');
  } catch (error) {
    console.error('Error refreshing data with new view:', error);
    showToast(`Switched to ${name}, but data refresh failed`, 'warning');
  }
}

/**
 * Initialize view selector on page load.
 *
 * Restores saved view selection from localStorage and validates
 * that the view still exists. Clears invalid selections.
 */
export async function initViewSelector(): Promise<void> {
  // Restore saved selection first (for immediate UI feedback)
  const savedViewId = localStorage.getItem('portfolioViewId');
  if (savedViewId) {
    store.set('currentViewId', savedViewId);
  }

  // Load views and validate saved selection
  await loadViews();

  // Validate saved view ID exists after views are loaded
  if (savedViewId) {
    const views = store.get('availableViews');
    const exists = views.some((v) => v.id === savedViewId);
    if (!exists && views.length > 0) {
      console.warn(`Saved view ID ${savedViewId} not found - clearing selection`);
      localStorage.removeItem('portfolioViewId');
      store.set('currentViewId', null);
    }
  }
}
