/**
 * Tests for the phone bottom tab bar and its link to the sidebar drawer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { showTab, initMobileNav, toggleMobileNav } from '@/ui/tabs';

function bottom(tab: string): HTMLElement {
  return document.querySelector(`.bottom-tab[data-tab="${tab}"]`) as HTMLElement;
}
function sidebarItem(tab: string): HTMLElement {
  return document.querySelector(`.nav-item[data-tab="${tab}"]`) as HTMLElement;
}
const more = (): HTMLElement => document.getElementById('bottom-tab-more') as HTMLElement;

describe('bottom tab bar', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <aside class="sidebar" id="app-sidebar">
        <button class="nav-item" data-tab="dashboard"></button>
        <button class="nav-item" data-tab="holdings"></button>
        <button class="nav-item" data-tab="debts"></button>
        <button class="nav-item" data-tab="settings"></button>
      </aside>
      <div class="tab-content" id="tab-dashboard"></div>
      <div class="tab-content" id="tab-holdings"></div>
      <div class="tab-content" id="tab-settings"></div>
      <div class="tab-content" id="tab-debts"></div>
      <div class="install-tab" data-tab="git"></div>
      <nav class="bottom-tabbar">
        <button class="bottom-tab" data-tab="dashboard"></button>
        <button class="bottom-tab" data-tab="holdings"></button>
        <button class="bottom-tab bottom-tab--more" id="bottom-tab-more" aria-expanded="false" aria-controls="app-sidebar"></button>
      </nav>`;
    initMobileNav();
  });

  it('activates the bar button and the sidebar item together', () => {
    showTab('holdings');
    for (const el of [bottom('holdings'), sidebarItem('holdings')]) {
      expect(el.classList.contains('active')).toBe(true);
      expect(el.getAttribute('aria-current')).toBe('page');
    }
    expect(bottom('dashboard').classList.contains('active')).toBe(false);
    expect(bottom('dashboard').hasAttribute('aria-current')).toBe(false);
    expect(more().classList.contains('active')).toBe(false);
  });

  it('marks More active on the Debts page and keeps its sidebar item active', () => {
    showTab('debts');
    expect(more().classList.contains('active')).toBe(true);
    expect(sidebarItem('debts').classList.contains('active')).toBe(true);
    expect(document.querySelector('.bottom-tab[data-tab="debts"]')).toBeNull();
  });

  it('does not touch non-navigation data-tab elements', () => {
    showTab('holdings');
    const install = document.querySelector('.install-tab') as HTMLElement;
    expect(install.classList.contains('active')).toBe(false);
    expect(install.hasAttribute('aria-current')).toBe(false);
  });

  it('marks More active for tabs without a bar button', () => {
    showTab('settings');
    expect(more().classList.contains('active')).toBe(true);
    showTab('dashboard');
    expect(more().classList.contains('active')).toBe(false);
  });

  it('opens the drawer from More and keeps aria-expanded in sync', () => {
    const sidebar = document.getElementById('app-sidebar') as HTMLElement;
    more().click();
    expect(sidebar.classList.contains('mobile-open')).toBe(true);
    expect(more().getAttribute('aria-expanded')).toBe('true');
    toggleMobileNav();
    expect(more().getAttribute('aria-expanded')).toBe('false');
  });

  it('resets aria-expanded when a tab change closes the drawer', () => {
    more().click();
    showTab('holdings');
    expect(more().getAttribute('aria-expanded')).toBe('false');
    expect((document.getElementById('app-sidebar') as HTMLElement).classList.contains('mobile-open')).toBe(false);
  });

  it('creates the drawer overlay on body (outside any containing block) and closes on click', () => {
    const overlay = document.querySelector('.mobile-nav-overlay') as HTMLElement;
    expect(overlay.parentElement).toBe(document.body);
    more().click();
    expect(overlay.style.display).toBe('block');
    overlay.click();
    expect(overlay.style.display).toBe('none');
    expect(more().getAttribute('aria-expanded')).toBe('false');
  });
});
