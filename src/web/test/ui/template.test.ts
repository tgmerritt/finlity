/**
 * Tests for createModal factory.
 */

import { describe, it, expect } from 'vitest';
import { createModal } from '@/ui/template';

describe('createModal', () => {
  it('builds an overlay with title, body, and close button', () => {
    const overlay = createModal({
      id: 'test-modal',
      title: 'Confirm Action',
      body: 'Proceed?',
    });

    expect(overlay.id).toBe('test-modal');
    expect(overlay.className).toContain('modal-overlay');
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');

    const title = overlay.querySelector('.modal-title');
    expect(title?.textContent).toBe('Confirm Action');

    const body = overlay.querySelector('.modal-body');
    expect(body?.textContent).toBe('Proceed?');

    const closeBtn = overlay.querySelector('.modal-close');
    expect(closeBtn).not.toBeNull();
    expect(closeBtn?.getAttribute('aria-label')).toBe('Close');
  });

  it('close button hides the overlay', () => {
    const overlay = createModal({
      id: 'x',
      title: 't',
      body: 'b',
    });
    overlay.style.display = 'flex';

    const closeBtn = overlay.querySelector<HTMLButtonElement>('.modal-close');
    closeBtn?.click();
    expect(overlay.style.display).toBe('none');
  });

  it('appends a Node body when passed one', () => {
    const content = document.createElement('form');
    content.className = 'inner-form';
    const overlay = createModal({
      id: 'form-modal',
      title: 'Form',
      body: content,
    });

    expect(overlay.querySelector('.inner-form')).not.toBeNull();
  });

  it('renders an optional subtitle', () => {
    const overlay = createModal({
      id: 'sub',
      title: 'T',
      subtitle: 'extra context',
      body: 'body',
    });
    expect(overlay.querySelector('.modal-subtitle')?.textContent).toBe('extra context');
  });

  it('renders a footer when provided', () => {
    const footer = document.createElement('div');
    footer.textContent = 'footer-text';
    const overlay = createModal({
      id: 'f',
      title: 'T',
      body: 'b',
      footer,
    });
    expect(overlay.querySelector('.modal-footer')?.textContent).toBe('footer-text');
  });
});
