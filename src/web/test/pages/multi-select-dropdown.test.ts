/**
 * Tests for the multi-select dropdown auto-close behaviour.
 *
 * Covers the audit-finding behaviour: clicking outside an open dropdown
 * closes it, the trigger button toggles correctly without the outside-click
 * listener fighting it, and Escape closes any open dropdown.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  toggleMultiSelect,
  closeAllMultiSelects,
  installMultiSelectAutoClose,
} from '@/pages/holdings';

function buildDropdown(id: string): {
  wrapper: HTMLElement;
  trigger: HTMLElement;
  menu: HTMLElement;
} {
  const wrapper = document.createElement('div');
  wrapper.className = 'multi-select-dropdown';
  wrapper.id = id;

  const trigger = document.createElement('button');
  trigger.className = 'multi-select-trigger';
  trigger.type = 'button';
  trigger.textContent = 'Open';
  trigger.addEventListener('click', () => toggleMultiSelect(id));

  const menu = document.createElement('div');
  menu.className = 'multi-select-menu';

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);
  document.body.appendChild(wrapper);

  return { wrapper, trigger, menu };
}

describe('multi-select dropdown auto-close', () => {
  beforeEach(() => {
    document.body.textContent = '';
    // closeAllMultiSelects is idempotent and safe to run between tests to
    // ensure no stale `.open` classes leak between cases.
    closeAllMultiSelects();
    // installMultiSelectAutoClose is itself idempotent — calling it across
    // tests does not stack listeners.
    installMultiSelectAutoClose();
  });

  it('closes any open dropdowns when the user clicks outside', () => {
    const { wrapper, trigger } = buildDropdown('dd-outside');

    trigger.click();
    expect(wrapper.classList.contains('open')).toBe(true);

    const elsewhere = document.createElement('div');
    elsewhere.id = 'unrelated';
    document.body.appendChild(elsewhere);

    elsewhere.click();
    expect(wrapper.classList.contains('open')).toBe(false);
  });

  it('does NOT close the dropdown when the trigger itself is clicked', () => {
    const { wrapper, trigger } = buildDropdown('dd-trigger');

    // Open
    trigger.click();
    expect(wrapper.classList.contains('open')).toBe(true);

    // Close (toggle off) — the outside-click handler must not fire here
    // because the trigger is inside `.multi-select-dropdown`.
    trigger.click();
    expect(wrapper.classList.contains('open')).toBe(false);

    // Re-open to confirm the toggle is symmetrical
    trigger.click();
    expect(wrapper.classList.contains('open')).toBe(true);
  });

  it('closes only one of many open dropdowns when re-opening another', () => {
    const a = buildDropdown('dd-a');
    const b = buildDropdown('dd-b');

    a.trigger.click();
    expect(a.wrapper.classList.contains('open')).toBe(true);

    // toggleMultiSelect closes all and opens the requested one.
    b.trigger.click();
    expect(a.wrapper.classList.contains('open')).toBe(false);
    expect(b.wrapper.classList.contains('open')).toBe(true);
  });

  it('closes any open dropdown when Escape is pressed', () => {
    const { wrapper, trigger } = buildDropdown('dd-escape');

    trigger.click();
    expect(wrapper.classList.contains('open')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.classList.contains('open')).toBe(false);
  });

  it('Escape with no open dropdown is a no-op', () => {
    const { wrapper } = buildDropdown('dd-noop');
    expect(wrapper.classList.contains('open')).toBe(false);

    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    ).not.toThrow();
    expect(wrapper.classList.contains('open')).toBe(false);
  });
});
