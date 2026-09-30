/**
 * Tests for the page toolbar (page title and View/Person filters).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { toolbarStateFor, initPageToolbar } from '@/ui/page-toolbar';
import { showTab, type TabName } from '@/ui/tabs';

describe('toolbarStateFor', () => {
  const cases: [TabName, string, boolean][] = [
    ['dashboard', 'Dashboard', true],
    ['holdings', 'Holdings', true],
    ['analysis', 'Analysis', true],
    ['projections', 'Projections', true],
    ['budget', 'Expenses & Income', false],
    ['taxes', 'Taxes', false],
    ['settings', 'Settings', false],
  ];

  it.each(cases)('%s -> "%s", filters %s', (tab, title, showFilters) => {
    expect(toolbarStateFor(tab)).toEqual({ title, showFilters });
  });
});

describe('initPageToolbar', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="page-toolbar" id="page-toolbar">
        <h1 class="page-title" id="page-title">Dashboard</h1>
        <div class="page-filters"></div>
      </div>
      <div class="tab-content" id="tab-dashboard"></div>
      <div class="tab-content" id="tab-holdings"></div>
      <div class="tab-content" id="tab-taxes"></div>
    `;
    initPageToolbar();
  });

  it('hides filters and sets the title on the taxes tab', () => {
    showTab('taxes');
    expect(document.getElementById('page-title')?.textContent).toBe('Taxes');
    expect(document.getElementById('page-toolbar')?.classList.contains('page-toolbar--no-filters')).toBe(true);
  });

  it('shows filters and sets the title on the holdings tab', () => {
    showTab('taxes');
    showTab('holdings');
    expect(document.getElementById('page-title')?.textContent).toBe('Holdings');
    expect(document.getElementById('page-toolbar')?.classList.contains('page-toolbar--no-filters')).toBe(false);
  });
});
