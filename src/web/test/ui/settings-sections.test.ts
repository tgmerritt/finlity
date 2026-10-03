import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initSettingsSections,
  refreshSettingsSectionVisibility,
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
