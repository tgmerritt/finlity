/**
 * After a result appears, the Monte Carlo inputs panel collapses on phones only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/api/client', () => ({ apiCall: vi.fn().mockResolvedValue({}) }));
vi.mock('@/ui/toast', () => ({
  showToast: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));
vi.mock('@/charts/projections', () => ({
  displayProjectionResults: vi.fn().mockResolvedValue(undefined),
}));

import { collapseConfigPanelOnPhone, toggleConfigPanel } from '@/pages/projections';

function setViewport(width: number): void {
  window.innerWidth = width;
}

describe('collapseConfigPanelOnPhone', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="config-panel" id="monte-carlo-config-panel"></div>';
  });

  it('collapses the panel at phone width', () => {
    setViewport(390);
    collapseConfigPanelOnPhone('monte-carlo-config-panel');
    expect(document.getElementById('monte-carlo-config-panel')!.classList.contains('collapsed')).toBe(true);
  });

  it('leaves the panel as it was on desktop', () => {
    setViewport(1440);
    collapseConfigPanelOnPhone('monte-carlo-config-panel');
    expect(document.getElementById('monte-carlo-config-panel')!.classList.contains('collapsed')).toBe(false);
  });

  it('lets the user reopen it with the header toggle', () => {
    setViewport(390);
    collapseConfigPanelOnPhone('monte-carlo-config-panel');
    toggleConfigPanel('monte-carlo-config-panel');
    expect(document.getElementById('monte-carlo-config-panel')!.classList.contains('collapsed')).toBe(false);
  });

  it('ignores a missing panel', () => {
    setViewport(390);
    expect(() => collapseConfigPanelOnPhone('nope')).not.toThrow();
  });
});

describe('toggleConfigPanel', () => {
  it('toggles collapsed on a panel with no initial class', () => {
    document.body.innerHTML = '<div id="p"></div>';
    toggleConfigPanel('p');
    expect(document.getElementById('p')!.classList.contains('collapsed')).toBe(true);
  });
});

describe('projections tab markup', () => {
  const root = resolve(__dirname, '../..');
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const css = readFileSync(resolve(root, 'style.css'), 'utf8');

  function load(): HTMLElement {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tab = doc.getElementById('tab-projections')!;
    document.head.innerHTML = '<style></style>';
    document.head.querySelector('style')!.textContent = css;
    document.body.innerHTML = '';
    document.body.appendChild(document.importNode(tab, true));
    return document.getElementById('tab-projections')!;
  }

  it('is not displayed before showTab runs (no inline style on the tab)', () => {
    const tab = load();
    expect(tab.getAttribute('style')).toBeNull();
    expect(getComputedStyle(tab).display).toBe('none');
  });

  it('keeps form, results and cards in one wrapper, with the metrics row outside it', () => {
    const tab = load();
    const body = tab.querySelector('#projections-body')!;
    expect(body.querySelector('#projection-form')).not.toBeNull();
    expect(body.querySelector('#projection-results')).not.toBeNull();
    expect(body.querySelector('#retirement-metrics-row')).toBeNull();
    expect(tab.querySelector('#retirement-metrics-row')).not.toBeNull();
  });

  it('orders the form before the results in the phone stylesheet', () => {
    const order = (sel: string) =>
      Number(new RegExp(sel + String.raw`\s*\{[^}]*order:\s*(\d+)`).exec(css)?.[1]);
    expect(order(String.raw`\.projections-body > #projection-form`)).toBeLessThan(
      order(String.raw`\.projections-body > #projection-results`)
    );
  });

  it('does not force display on the tab itself', () => {
    expect(css).not.toMatch(/#tab-projections[^{]*\{[^}]*!important/);
  });
});
