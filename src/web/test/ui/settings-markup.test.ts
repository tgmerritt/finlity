/**
 * Structure of the real Settings page markup: cards grouped into sections.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SECTIONS: Array<{ id: string; title: string; cards: string[] }> = [
  { id: 'settings-profile', title: 'Profile & goals', cards: ['Personal Settings', 'Entity Management', 'Profile Management', 'Portfolio Views'] },
  { id: 'settings-targets', title: 'Targets', cards: ['Asset Class Targets'] },
  { id: 'settings-assumptions', title: 'Assumptions', cards: ['Market Assumptions', 'Monte Carlo Settings'] },
  { id: 'settings-accounts-data', title: 'Accounts & data', cards: ['Account Management', 'Data Storage', 'Data Export', 'Demo Mode'] },
  { id: 'settings-imported-transactions', title: 'Imported transactions', cards: ['Imported transactions', 'Remembered merchants'] },
  { id: 'settings-sources-ai', title: 'Data sources & AI', cards: ['Data Sources', 'AI Provider'] },
  { id: 'settings-plugins', title: 'Plugins', cards: ['Plugin Security', 'Plugin Marketplace', 'Plugins'] },
  { id: 'settings-appearance', title: 'Appearance', cards: ['Appearance'] },
];

function cardTitle(card: Element): string {
  const h3 = card.querySelector('h3');
  const clone = h3!.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button').forEach((b) => b.remove());
  return clone.textContent!.trim();
}

describe('settings markup', () => {
  beforeEach(() => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  });

  it('has the sections in order, each with its cards', () => {
    const sections = Array.from(document.querySelectorAll('#tab-settings .settings-section'));
    expect(sections.map((s) => s.id)).toEqual(SECTIONS.map((s) => s.id));
    sections.forEach((section, i) => {
      expect(section.querySelector('.settings-section-heading > .settings-section-header')!.textContent).toBe(SECTIONS[i].title);
      const cards = Array.from(section.querySelectorAll('.settings-grid > .card')).map(cardTitle);
      expect(cards).toEqual(SECTIONS[i].cards);
    });
  });

  it('keeps all 19 cards and no card outside a section', () => {
    expect(document.querySelectorAll('#tab-settings .card').length).toBe(19);
    expect(document.querySelectorAll('#tab-settings .settings-section .card').length).toBe(19);
  });

  it('has one index link per section', () => {
    const links = Array.from(document.querySelectorAll('#settings-index a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(SECTIONS.map((s) => `#${s.id}`));
  });

  it('wires each header to its body', () => {
    for (const s of SECTIONS) {
      const header = document.getElementById(`${s.id}-header`)!;
      expect(header.tagName).toBe('BUTTON');
      expect(document.getElementById(header.getAttribute('aria-controls')!)).not.toBeNull();
    }
  });
});
