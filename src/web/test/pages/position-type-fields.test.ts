/**
 * Tests for position-type field visibility in the Add/Edit Position modals.
 *
 * Regression coverage for the "Please enter a cash amount" dead-end: the
 * field sections carry the `.hidden` class (display: none !important) in the
 * markup, so toggling inline `style.display` alone can never reveal them.
 * Visibility must be driven by adding/removing the `hidden` class.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { togglePositionTypeFields, showEditPositionModal } from '@/pages/holdings';

/**
 * Mirrors the real stylesheet semantics: `.hidden { display: none !important }`
 * defeats any inline display value, and an inline `display: none` hides the
 * element regardless of class. An element is effectively visible only when
 * neither applies.
 */
function isEffectivelyVisible(el: HTMLElement): boolean {
  return !el.classList.contains('hidden') && el.style.display !== 'none';
}

function addDiv(id: string, hidden: boolean): HTMLElement {
  const div = document.createElement('div');
  div.id = id;
  if (hidden) div.className = 'hidden';
  document.body.appendChild(div);
  return div;
}

function addSelect(id: string, values: string[]): HTMLSelectElement {
  const select = document.createElement('select');
  select.id = id;
  values.forEach((v) => {
    const option = document.createElement('option');
    option.value = v;
    select.appendChild(option);
  });
  document.body.appendChild(select);
  return select;
}

describe('togglePositionTypeFields', () => {
  let select: HTMLSelectElement;
  let stockFields: HTMLElement;
  let cashFields: HTMLElement;
  let cdFields: HTMLElement;
  let realEstateFields: HTMLElement;

  beforeEach(() => {
    document.body.textContent = '';
    // Same initial state as index.html: stock fields visible by default,
    // the cash/CD/real-estate sections start with class="hidden".
    select = addSelect('position-type', ['equity', 'fund', 'cash', 'cd', 'real_estate']);
    stockFields = addDiv('stock-fields', false);
    cashFields = addDiv('cash-fields', true);
    cdFields = addDiv('cd-fields', true);
    realEstateFields = addDiv('real-estate-fields', true);
  });

  it('reveals the cash amount fields when Cash is selected', () => {
    select.value = 'cash';
    togglePositionTypeFields();

    expect(isEffectivelyVisible(cashFields)).toBe(true);
    expect(isEffectivelyVisible(stockFields)).toBe(false);
    expect(isEffectivelyVisible(cdFields)).toBe(false);
    expect(isEffectivelyVisible(realEstateFields)).toBe(false);
  });

  it('reveals the CD fields when CD is selected', () => {
    select.value = 'cd';
    togglePositionTypeFields();

    expect(isEffectivelyVisible(cdFields)).toBe(true);
    expect(isEffectivelyVisible(cashFields)).toBe(false);
  });

  it('reveals the real estate fields when Real Estate is selected', () => {
    select.value = 'real_estate';
    togglePositionTypeFields();

    expect(isEffectivelyVisible(realEstateFields)).toBe(true);
    expect(isEffectivelyVisible(stockFields)).toBe(false);
  });

  it('returns to stock fields after switching away and back', () => {
    select.value = 'cash';
    togglePositionTypeFields();
    select.value = 'equity';
    togglePositionTypeFields();

    expect(isEffectivelyVisible(stockFields)).toBe(true);
    expect(isEffectivelyVisible(cashFields)).toBe(false);
  });
});

describe('showEditPositionModal interest fields', () => {
  let interestFields: HTMLElement;

  beforeEach(() => {
    document.body.textContent = '';
    // Minimal edit-form inputs the function writes into.
    ['edit-position-id', 'edit-position-ticker', 'edit-position-shares'].forEach((id) => {
      const input = document.createElement('input');
      input.id = id;
      document.body.appendChild(input);
    });
    // As in index.html, the interest section starts with class="hidden".
    interestFields = addDiv('edit-interest-fields', true);
  });

  it('reveals the interest fields for a cash position', () => {
    showEditPositionModal('pos-1', 'Cash', 1, 100, 100, 'cash', 0.045, '', '');
    expect(isEffectivelyVisible(interestFields)).toBe(true);
  });

  it('keeps the interest fields hidden for an equity position', () => {
    showEditPositionModal('pos-2', 'AAPL', 10, 150, 1200, 'equity', null, '', '');
    expect(isEffectivelyVisible(interestFields)).toBe(false);
  });
});
