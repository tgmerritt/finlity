/**
 * Page toolbar: page title plus the View and Person filters.
 */

import { getCurrentTab, onTabChange, type TabName } from '@/ui/tabs';

export interface ToolbarState {
  title: string;
  showFilters: boolean;
}

const TOOLBAR_STATES: Record<TabName, ToolbarState> = {
  dashboard: { title: 'Dashboard', showFilters: true },
  holdings: { title: 'Holdings', showFilters: true },
  analysis: { title: 'Analysis', showFilters: true },
  projections: { title: 'Projections', showFilters: true },
  budget: { title: 'Expenses & Income', showFilters: false },
  taxes: { title: 'Taxes', showFilters: false },
  settings: { title: 'Settings', showFilters: false },
};

/**
 * Title and filter visibility for a tab.
 */
export function toolbarStateFor(tab: TabName): ToolbarState {
  return TOOLBAR_STATES[tab];
}

function applyState(tab: TabName): void {
  const toolbar = document.getElementById('page-toolbar');
  const title = document.getElementById('page-title');
  if (!toolbar || !title) return;
  const state = toolbarStateFor(tab);
  title.textContent = state.title;
  toolbar.classList.toggle('page-toolbar--no-filters', !state.showFilters);
}

/**
 * Keep the toolbar in sync with the active tab.
 */
export function initPageToolbar(): void {
  onTabChange(applyState);
  applyState(getCurrentTab());
}
