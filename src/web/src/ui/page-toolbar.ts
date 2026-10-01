/**
 * Page toolbar: page title plus the View and Person filters.
 */

import { getCurrentTab, onTabChange, type TabName } from '@/ui/tabs';

export interface ToolbarState {
  title: string;
  showView: boolean;
  showPerson: boolean;
}

const TOOLBAR_STATES: Record<TabName, ToolbarState> = {
  dashboard: { title: 'Dashboard', showView: true, showPerson: true },
  holdings: { title: 'Holdings', showView: true, showPerson: true },
  analysis: { title: 'Analysis', showView: true, showPerson: true },
  projections: { title: 'Projections', showView: true, showPerson: true },
  budget: { title: 'Expenses & Income', showView: false, showPerson: true },
  taxes: { title: 'Taxes', showView: false, showPerson: false },
  settings: { title: 'Settings', showView: false, showPerson: false },
};

/**
 * Title and per-filter visibility for a tab.
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
  toolbar.classList.toggle('page-toolbar--no-filters', !state.showView && !state.showPerson);
  const filters = toolbar.querySelector('.page-filters');
  filters?.classList.toggle('page-filters--single', state.showView !== state.showPerson);
  toolbar
    .querySelector('.view-selector:not(.entity-selector)')
    ?.classList.toggle('filter--hidden', !state.showView);
  toolbar.querySelector('.entity-selector')?.classList.toggle('filter--hidden', !state.showPerson);
}

/**
 * Keep the toolbar in sync with the active tab.
 */
export function initPageToolbar(): void {
  onTabChange(applyState);
  applyState(getCurrentTab());
}
