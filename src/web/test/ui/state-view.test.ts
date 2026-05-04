/**
 * Tests for the inline state-view component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStateView, setStateView, clearStateView } from '@/ui/state-view';

describe('createStateView', () => {
  it('returns a div with the kind-specific modifier class', () => {
    const loading = createStateView({ kind: 'loading' });
    const empty = createStateView({ kind: 'empty' });
    const error = createStateView({ kind: 'error' });

    expect(loading.tagName).toBe('DIV');
    expect(loading.classList.contains('state-view')).toBe(true);
    expect(loading.classList.contains('state-view--loading')).toBe(true);
    expect(empty.classList.contains('state-view--empty')).toBe(true);
    expect(error.classList.contains('state-view--error')).toBe(true);
  });

  it('renders default per-kind titles', () => {
    expect(createStateView({ kind: 'loading' }).querySelector('.state-view-title')?.textContent).toBe(
      'Loading'
    );
    expect(createStateView({ kind: 'empty' }).querySelector('.state-view-title')?.textContent).toBe(
      'No data yet'
    );
    expect(createStateView({ kind: 'error' }).querySelector('.state-view-title')?.textContent).toBe(
      'Could not load'
    );
  });

  it('renders title, description, and action button when provided', () => {
    const view = createStateView({
      kind: 'empty',
      title: 'No holdings yet',
      description: 'Import from a broker CSV.',
      action: { label: 'Add Position', onClick: () => {} },
    });

    expect(view.querySelector('.state-view-title')?.textContent).toBe('No holdings yet');
    expect(view.querySelector('.state-view-description')?.textContent).toBe(
      'Import from a broker CSV.'
    );
    const btn = view.querySelector<HTMLButtonElement>('button.state-view-action');
    expect(btn?.textContent).toBe('Add Position');
    expect(btn?.type).toBe('button');
  });

  it('omits description and action when not provided', () => {
    const view = createStateView({ kind: 'loading' });
    expect(view.querySelector('.state-view-description')).toBeNull();
    expect(view.querySelector('button.state-view-action')).toBeNull();
  });

  it('fires action.onClick when the action button is clicked', () => {
    const onClick = vi.fn();
    const view = createStateView({
      kind: 'error',
      action: { label: 'Retry', onClick },
    });
    const btn = view.querySelector<HTMLButtonElement>('button.state-view-action');
    expect(btn).not.toBeNull();
    btn?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('uses role="alert" for errors and role="status" for loading/empty', () => {
    expect(createStateView({ kind: 'error' }).getAttribute('role')).toBe('alert');
    expect(createStateView({ kind: 'empty' }).getAttribute('role')).toBe('status');
    expect(createStateView({ kind: 'loading' }).getAttribute('role')).toBe('status');
  });
});

describe('setStateView', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('replaces existing children of the target container', () => {
    const host = document.createElement('div');
    host.id = 'host';
    host.appendChild(document.createElement('span'));
    host.appendChild(document.createTextNode('previous'));
    document.body.appendChild(host);

    setStateView('#host', { kind: 'empty', title: 'Nothing' });

    expect(host.children).toHaveLength(1);
    expect(host.children[0].classList.contains('state-view--empty')).toBe(true);
    expect(host.querySelector('.state-view-title')?.textContent).toBe('Nothing');
    // Original text/children gone.
    expect(host.textContent).not.toContain('previous');
  });

  it('accepts an Element directly', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    setStateView(host, { kind: 'loading' });
    expect(host.querySelector('.state-view--loading')).not.toBeNull();
  });

  it('swaps cleanly on repeated calls (no leftover DOM from prior state)', () => {
    const host = document.createElement('div');
    host.id = 'host2';
    document.body.appendChild(host);

    setStateView('#host2', { kind: 'loading' });
    expect(host.querySelectorAll('.state-view')).toHaveLength(1);
    expect(host.querySelector('.state-view--loading')).not.toBeNull();

    setStateView('#host2', { kind: 'empty', title: 'No data' });
    expect(host.querySelectorAll('.state-view')).toHaveLength(1);
    expect(host.querySelector('.state-view--loading')).toBeNull();
    expect(host.querySelector('.state-view--empty')).not.toBeNull();
    expect(host.querySelector('.state-view-title')?.textContent).toBe('No data');

    setStateView('#host2', { kind: 'error', title: 'Boom' });
    expect(host.querySelectorAll('.state-view')).toHaveLength(1);
    expect(host.querySelector('.state-view--empty')).toBeNull();
    expect(host.querySelector('.state-view--error')).not.toBeNull();
  });
});

describe('clearStateView', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('removes a state view but leaves regular children alone', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const sibling = document.createElement('p');
    sibling.textContent = 'real data';
    host.appendChild(sibling);
    host.appendChild(createStateView({ kind: 'loading' }));

    expect(host.querySelectorAll('.state-view')).toHaveLength(1);
    const removed = clearStateView(host);

    expect(removed).toBe(true);
    expect(host.querySelectorAll('.state-view')).toHaveLength(0);
    // The sibling is untouched.
    expect(host.contains(sibling)).toBe(true);
    expect(host.textContent).toBe('real data');
  });

  it('returns false when there is no state view to remove', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.appendChild(document.createElement('span'));

    expect(clearStateView(host)).toBe(false);
    expect(host.children).toHaveLength(1);
  });

  it('returns false for an unknown selector', () => {
    expect(clearStateView('#does-not-exist')).toBe(false);
  });
});
