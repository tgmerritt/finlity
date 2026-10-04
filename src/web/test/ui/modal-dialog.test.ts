/**
 * Dialog semantics of createDynamicModal: role, labelling, focus trap, focus
 * return and listener cleanup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDynamicModal, closeDynamicModal } from '@/ui/modal';

function content(): HTMLElement {
  const wrap = document.createElement('div');
  for (const name of ['one', 'two']) {
    const input = document.createElement('input');
    input.id = name;
    wrap.appendChild(input);
  }
  return wrap;
}

function tab(shift = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe('createDynamicModal dialog semantics', () => {
  let opener: HTMLButtonElement;
  beforeEach(() => {
    document.body.innerHTML = '<button id="opener">Open</button>';
    opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();
  });
  afterEach(() => closeDynamicModal());

  it('is a labelled modal dialog', () => {
    const modal = createDynamicModal({ title: 'Edit thing', content: content() });
    const dialog = modal.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toBe('Edit thing');
  });

  it('keeps Tab inside the dialog', () => {
    const modal = createDynamicModal({ title: 'T', content: content() });
    const buttons = modal.querySelectorAll<HTMLElement>('button, input');
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    last.focus();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    first.focus();
    expect(tab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the invoker on close', () => {
    createDynamicModal({ title: 'T', content: content() });
    expect(document.activeElement).not.toBe(opener);
    closeDynamicModal();
    expect(document.activeElement).toBe(opener);
  });

  it('removes the Escape listener on every close path', () => {
    const onClose = vi.fn();
    createDynamicModal({ title: 'T', content: content(), onClose });
    closeDynamicModal();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and calls onClose once', () => {
    const onClose = vi.fn();
    createDynamicModal({ title: 'T', content: content(), onClose });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('dynamic-modal')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it('keeps focus on the opening control when one dialog replaces another', () => {
    createDynamicModal({ title: 'A', content: content() });
    createDynamicModal({ title: 'B', content: content() });
    expect(document.querySelectorAll('#dynamic-modal')).toHaveLength(1);
    closeDynamicModal();
    expect(document.activeElement).toBe(opener);
  });

  it('stays open on X, backdrop, Cancel and Escape while canClose says no', () => {
    let allow = false;
    const onClose = vi.fn();
    const modal = createDynamicModal({
      title: 'T',
      content: content(),
      onClose,
      canClose: () => allow,
    });
    (modal.querySelector('.modal-close') as HTMLElement).click();
    (modal.querySelector('.modal-backdrop') as HTMLElement).click();
    (modal.querySelector('[data-action="cancel"]') as HTMLElement).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.isConnected).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    allow = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
