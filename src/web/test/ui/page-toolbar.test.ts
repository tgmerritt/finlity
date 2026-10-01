/**
 * Tests for the page toolbar (page title and View/Person filters).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { toolbarStateFor, initPageToolbar } from '@/ui/page-toolbar';
import { showTab, type TabName } from '@/ui/tabs';

describe('toolbarStateFor', () => {
  const cases: [TabName, string, boolean, boolean][] = [
    ['dashboard', 'Dashboard', true, true],
    ['holdings', 'Holdings', true, true],
    ['analysis', 'Analysis', true, true],
    ['projections', 'Projections', true, true],
    ['budget', 'Expenses & Income', false, true],
    ['taxes', 'Taxes', false, false],
    ['settings', 'Settings', false, false],
  ];

  it.each(cases)('%s -> "%s", view %s, person %s', (tab, title, showView, showPerson) => {
    expect(toolbarStateFor(tab)).toEqual({ title, showView, showPerson });
  });
});

describe('initPageToolbar', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="page-toolbar" id="page-toolbar">
        <h1 class="page-title" id="page-title">Dashboard</h1>
        <div class="page-filters">
          <div class="view-selector" id="view-block"></div>
          <div class="view-selector entity-selector" id="person-block"></div>
        </div>
      </div>
      <div class="tab-content" id="tab-dashboard"></div>
      <div class="tab-content" id="tab-budget"></div>
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

  it('shows only the Person filter on the cash flow tab', () => {
    showTab('budget');
    expect(document.getElementById('page-toolbar')?.classList.contains('page-toolbar--no-filters')).toBe(false);
    expect(document.getElementById('view-block')?.classList.contains('filter--hidden')).toBe(true);
    expect(document.getElementById('person-block')?.classList.contains('filter--hidden')).toBe(false);
    expect(document.querySelector('.page-filters')?.classList.contains('page-filters--single')).toBe(true);
  });

  it('shows both filters on holdings', () => {
    showTab('budget');
    showTab('holdings');
    expect(document.getElementById('view-block')?.classList.contains('filter--hidden')).toBe(false);
    expect(document.getElementById('person-block')?.classList.contains('filter--hidden')).toBe(false);
    expect(document.querySelector('.page-filters')?.classList.contains('page-filters--single')).toBe(false);
  });
});
