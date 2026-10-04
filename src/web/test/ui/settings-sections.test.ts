import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  goToSection,
  initSettingsSections,
  refreshSettingsSectionVisibility,
  revealInSettings,
} from '@/ui/settings-sections';

let phone = false;
let changeHandler: (() => void) | null = null;

function stubMatchMedia(): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: phone && query.includes('768px'),
    media: query,
    addEventListener: (_: string, cb: () => void) => {
      changeHandler = cb;
    },
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const section = (id: string): HTMLElement => document.getElementById(id)!;
const header = (id: string): HTMLElement => document.getElementById(`${id}-header`)!;
const body = (id: string): HTMLElement => document.getElementById(`${id}-body`)!;

function load(): void {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  initSettingsSections();
}

describe('settings sections on desktop', () => {
  beforeEach(() => {
    phone = false;
    changeHandler = null;
    stubMatchMedia();
    Element.prototype.scrollIntoView = vi.fn();
    load();
  });

  it('shows every section and is not collapsible', () => {
    for (const el of document.querySelectorAll('.settings-section')) {
      expect(body(el.id).hidden).toBe(false);
      expect(header(el.id).hasAttribute('aria-expanded')).toBe(false);
    }
    header('settings-targets').click();
    expect(body('settings-targets').hidden).toBe(false);
  });

  it('makes the header button inert to assistive tech', () => {
    for (const el of document.querySelectorAll('.settings-section')) {
      const h = header(el.id);
      expect(h.hasAttribute('aria-expanded')).toBe(false);
      expect(h.hasAttribute('aria-controls')).toBe(false);
      expect(h.hasAttribute('aria-disabled')).toBe(false);
      expect(h.getAttribute('role')).toBe('presentation');
      expect(h.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('scrolls to the section when an index link is clicked', () => {
    const link = document.querySelector<HTMLElement>('#settings-index [data-section="settings-plugins"]')!;
    link.click();
    expect(section('settings-plugins').scrollIntoView).toHaveBeenCalled();
    expect(link.classList.contains('active')).toBe(true);
  });

  it('hides a section whose cards are all hidden, with its link', () => {
    section('settings-targets').querySelectorAll('.card').forEach((c) => c.classList.add('hidden'));
    refreshSettingsSectionVisibility();
    expect(section('settings-targets').classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#settings-index [data-section="settings-targets"]')!.classList.contains('hidden')).toBe(true);
    expect(section('settings-profile').classList.contains('hidden')).toBe(false);
  });

  it('keeps a section visible when only some cards are hidden', () => {
    section('settings-accounts-data').querySelector('#data-storage-card')!.classList.add('hidden');
    refreshSettingsSectionVisibility();
    expect(section('settings-accounts-data').classList.contains('hidden')).toBe(false);
  });
});

describe('settings sections navigation details', () => {
  beforeEach(() => {
    phone = false;
    stubMatchMedia();
    Element.prototype.scrollIntoView = vi.fn();
    load();
  });

  it('moves focus to the target section on an index click', () => {
    document.querySelector<HTMLElement>('#settings-index [data-section="settings-targets"]')!.click();
    expect(document.activeElement).toBe(section('settings-targets'));
    expect(section('settings-targets').getAttribute('tabindex')).toBe('-1');
  });

  it('highlights the last section at the page bottom', () => {
    document.body.classList.add('on-settings');
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 1200, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    const active = document.querySelector('#settings-index .active') as HTMLElement;
    expect(active.dataset.section).toBe('settings-appearance');
  });

  it('ignores scrolling at the page bottom when Settings is not the open tab', () => {
    document.body.classList.remove('on-settings');
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 1200, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect((document.querySelector('#settings-index .active') as HTMLElement).dataset.section).toBe('settings-profile');
  });

  it('does not stack listeners when initialised repeatedly', () => {
    document.body.classList.add('on-settings');
    const spy = vi.spyOn(window, 'addEventListener');
    initSettingsSections();
    initSettingsSections();
    const removed = spy.mock.calls.filter(([type]) => type === 'scroll');
    expect(removed.length).toBe(2);
    const signals = removed.map(([, , opts]) => (opts as AddEventListenerOptions).signal!);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    spy.mockRestore();
  });

  it('does not let the bottom highlight override an index click scroll', () => {
    document.body.classList.add('on-settings');
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 1200, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    document.querySelector<HTMLElement>('#settings-index [data-section="settings-targets"]')!.click();
    window.dispatchEvent(new Event('scroll'));
    expect((document.querySelector('#settings-index .active') as HTMLElement).dataset.section).toBe('settings-targets');
  });

  it('puts each button inside an h2', () => {
    const headings = document.querySelectorAll('.settings-section > h2');
    expect(headings.length).toBe(9);
    for (const h of headings) {
      expect(h.querySelector(':scope > button.settings-section-header')).not.toBeNull();
    }
  });
});

describe('revealInSettings on phones', () => {
  it('opens the collapsed section containing an element', () => {
    phone = true;
    stubMatchMedia();
    load();
    const card = section('settings-plugins').querySelector('.card') as HTMLElement;
    expect(body('settings-plugins').hidden).toBe(true);
    revealInSettings(card);
    expect(body('settings-plugins').hidden).toBe(false);
    expect(header('settings-plugins').getAttribute('aria-expanded')).toBe('true');
  });

  it('covers the Manage profiles target', () => {
    phone = true;
    stubMatchMedia();
    load();
    revealInSettings(document.getElementById('profiles-management-list')!);
    expect(body('settings-profile').hidden).toBe(false);
  });
});

describe('settings sections on phones', () => {
  beforeEach(() => {
    phone = true;
    changeHandler = null;
    stubMatchMedia();
    Element.prototype.scrollIntoView = vi.fn();
    load();
  });

  it('opens the first section and closes the rest', () => {
    const ids = Array.from(document.querySelectorAll('.settings-section')).map((s) => s.id);
    ids.forEach((id, i) => {
      expect(header(id).getAttribute('aria-expanded')).toBe(i === 0 ? 'true' : 'false');
      expect(body(id).hidden).toBe(i !== 0);
    });
  });

  it('toggles a section from its header', () => {
    header('settings-targets').click();
    expect(header('settings-targets').getAttribute('aria-expanded')).toBe('true');
    expect(body('settings-targets').hidden).toBe(false);
    header('settings-targets').click();
    expect(header('settings-targets').getAttribute('aria-expanded')).toBe('false');
    expect(body('settings-targets').hidden).toBe(true);
  });

  it('opens a closed section before scrolling to it from an index link', () => {
    document.querySelector<HTMLElement>('#settings-index [data-section="settings-plugins"]')!.click();
    expect(body('settings-plugins').hidden).toBe(false);
    expect(section('settings-plugins').scrollIntoView).toHaveBeenCalled();
  });

  it('opens the first visible section when the first is hidden', () => {
    section('settings-profile').querySelectorAll('.card').forEach((c) => c.classList.add('hidden'));
    refreshSettingsSectionVisibility();
    expect(header('settings-targets').getAttribute('aria-expanded')).toBe('true');
  });

  it('switches to the all-open layout when the viewport widens', () => {
    phone = false;
    changeHandler!();
    expect(body('settings-plugins').hidden).toBe(false);
    expect(header('settings-plugins').hasAttribute('aria-expanded')).toBe(false);
  });
});

describe('settings sections accordion state', () => {
  beforeEach(() => {
    phone = true;
    changeHandler = null;
    stubMatchMedia();
    Element.prototype.scrollIntoView = vi.fn();
    load();
  });

  it('restores the header semantics when entering phone mode', () => {
    const h = header('settings-targets');
    expect(h.getAttribute('aria-controls')).toBe('settings-targets-body');
    expect(h.hasAttribute('role')).toBe(false);
    expect(h.hasAttribute('tabindex')).toBe(false);
    expect(h.hasAttribute('aria-disabled')).toBe(false);
  });

  it('opens a collapsed section with goToSection', () => {
    expect(body('settings-targets').hidden).toBe(true);
    goToSection('settings-targets');
    expect(body('settings-targets').hidden).toBe(false);
    expect(header('settings-targets').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps what the user opened across breakpoint changes', () => {
    header('settings-targets').click();
    header('settings-profile').click(); // close the default-open section
    phone = false;
    changeHandler!();
    expect(body('settings-profile').hidden).toBe(false);
    phone = true;
    changeHandler!();
    expect(body('settings-profile').hidden).toBe(true);
    expect(body('settings-targets').hidden).toBe(false);
    expect(body('settings-plugins').hidden).toBe(true);
  });

  it('uses first-open when the user never touched an accordion', () => {
    phone = false;
    changeHandler!();
    phone = true;
    changeHandler!();
    expect(body('settings-profile').hidden).toBe(false);
    expect(body('settings-targets').hidden).toBe(true);
  });
});
