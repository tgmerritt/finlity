/**
 * Accessibility of the phone navigation drawer: Escape, focus move, focus
 * trap, focus return, inert while closed, and the opener's ARIA wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initMobileNav, showTab } from '@/ui/tabs';

type Listener = () => void;
let phone = true;
let listeners: Listener[] = [];
const originalMatchMedia = window.matchMedia;

function stubMatchMedia(): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return phone;
    },
    media: query,
    addEventListener: (_: string, cb: Listener) => listeners.push(cb),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

const sidebar = (): HTMLElement => document.getElementById('app-sidebar') as HTMLElement;
const more = (): HTMLElement => document.getElementById('bottom-tab-more') as HTMLElement;
const item = (tab: string): HTMLElement =>
  document.querySelector(`.nav-item[data-tab="${tab}"]`) as HTMLElement;

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

describe('phone navigation drawer accessibility', () => {
  beforeEach(() => {
    phone = true;
    listeners = [];
    stubMatchMedia();
    document.body.innerHTML = `
      <aside class="sidebar" id="app-sidebar">
        <button class="nav-item" data-tab="dashboard">Dashboard</button>
        <button class="nav-item" data-tab="holdings">Holdings</button>
        <button class="nav-item" data-tab="settings">Settings</button>
        <button class="sidebar-collapse-toggle" style="display: none">Collapse</button>
      </aside>
      <div class="tab-content" id="tab-dashboard"></div>
      <div class="tab-content" id="tab-holdings"></div>
      <div class="tab-content" id="tab-settings"></div>
      <nav class="bottom-tabbar">
        <button class="bottom-tab" data-tab="dashboard">Home</button>
        <button class="bottom-tab bottom-tab--more" id="bottom-tab-more" aria-expanded="false" aria-controls="app-sidebar">More</button>
      </nav>`;
    initMobileNav();
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('wires the opener with aria-expanded and aria-controls', () => {
    expect(more().getAttribute('aria-controls')).toBe('app-sidebar');
    expect(more().getAttribute('aria-expanded')).toBe('false');
    more().click();
    expect(more().getAttribute('aria-expanded')).toBe('true');
  });

  it('is inert and aria-hidden while closed on phones, and reachable once open', () => {
    expect(sidebar().hasAttribute('inert')).toBe(true);
    expect(sidebar().getAttribute('aria-hidden')).toBe('true');
    more().click();
    expect(sidebar().hasAttribute('inert')).toBe(false);
    expect(sidebar().hasAttribute('aria-hidden')).toBe(false);
    press('Escape');
    expect(sidebar().hasAttribute('inert')).toBe(true);
    expect(sidebar().getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves the sidebar reachable on wider layouts and re-syncs on breakpoint change', () => {
    phone = false;
    listeners.forEach((cb) => cb());
    expect(sidebar().hasAttribute('inert')).toBe(false);
    expect(sidebar().hasAttribute('aria-hidden')).toBe(false);
    phone = true;
    listeners.forEach((cb) => cb());
    expect(sidebar().hasAttribute('inert')).toBe(true);
  });

  it('moves focus to the first focusable item when opened', () => {
    more().focus();
    more().click();
    expect(document.activeElement).toBe(item('dashboard'));
  });

  it('closes on Escape and returns focus to the opener', () => {
    more().focus();
    more().click();
    const event = press('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(sidebar().classList.contains('mobile-open')).toBe(false);
    expect(more().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more());
  });

  it('ignores Escape while the drawer is closed', () => {
    const event = press('Escape');
    expect(event.defaultPrevented).toBe(false);
  });

  it('traps Tab at the last item and Shift+Tab at the first, skipping hidden controls', () => {
    more().focus();
    more().click();
    item('settings').focus();
    const forward = press('Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item('dashboard'));

    const backward = press('Tab', { shiftKey: true });
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(item('settings'));
  });

  it('does not interfere with Tab in the middle of the drawer', () => {
    more().focus();
    more().click();
    item('holdings').focus();
    expect(press('Tab').defaultPrevented).toBe(false);
  });

  it('pulls focus back in if it escapes the open drawer', () => {
    more().focus();
    more().click();
    more().focus();
    press('Tab');
    expect(document.activeElement).toBe(item('dashboard'));
  });

  it('returns focus to the opener when a tab change closes the drawer', () => {
    more().focus();
    more().click();
    showTab('holdings');
    expect(sidebar().hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(more());
  });

  it('keeps focus in the nav when widening past the breakpoint with the drawer open', () => {
    showTab('holdings');
    more().focus();
    more().click();
    expect(sidebar().contains(document.activeElement)).toBe(true);
    phone = false;
    listeners.forEach((cb) => cb());
    expect(sidebar().classList.contains('mobile-open')).toBe(false);
    expect(sidebar().hasAttribute('inert')).toBe(false);
    expect(sidebar().hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(item('holdings'));
  });

  it('is neither inert nor aria-hidden when initialised on a wide layout', () => {
    phone = false;
    initMobileNav();
    expect(sidebar().hasAttribute('inert')).toBe(false);
    expect(sidebar().hasAttribute('aria-hidden')).toBe(false);
  });

  it('falls back to addListener when addEventListener is missing', () => {
    const added: Listener[] = [];
    window.matchMedia = vi.fn().mockImplementation(() => ({
      get matches() {
        return phone;
      },
      addListener: (cb: Listener) => added.push(cb),
    })) as unknown as typeof window.matchMedia;
    initMobileNav();
    expect(added).toHaveLength(1);
    phone = false;
    added.forEach((cb) => cb());
    expect(sidebar().hasAttribute('inert')).toBe(false);
  });

  it('skips visibility:hidden controls when choosing the first and last item', () => {
    item('dashboard').style.visibility = 'hidden';
    more().focus();
    more().click();
    expect(document.activeElement).toBe(item('holdings'));
  });

  it('closes only an open profile dropdown on the first Escape', () => {
    sidebar().insertAdjacentHTML(
      'beforeend',
      '<button id="profile-selector-btn">P</button><div id="profile-dropdown" style="display: block"></div>'
    );
    more().focus();
    more().click();
    press('Escape');
    expect(sidebar().classList.contains('mobile-open')).toBe(true);
    expect((document.getElementById('profile-dropdown') as HTMLElement).style.display).toBe('none');
    expect(document.activeElement).toBe(document.getElementById('profile-selector-btn'));
    press('Escape');
    expect(sidebar().classList.contains('mobile-open')).toBe(false);
  });
});
