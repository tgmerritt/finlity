/**
 * The plugin settings dialog is a dynamic modal, so Cancel and Save must close
 * it through closeDynamicModal (closeModal only hides the static generic modal).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiCall } = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock('@/api/client', () => ({ apiCall, uploadFile: vi.fn(), getBaseUrl: () => '' }));
vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/state/session', () => ({
  isSigningRequired: vi.fn().mockReturnValue(false),
  generateSignatureHeaders: vi.fn().mockResolvedValue({}),
}));

import { showPluginSettings } from '@/features/plugins';
import { closeDynamicModal } from '@/ui/modal';

async function open(): Promise<void> {
  apiCall.mockImplementation(async (url: string) =>
    url.endsWith('/settings')
      ? { schema: [{ key: 'k', label: 'K', type: 'text' }], settings: { k: 'v' } }
      : {}
  );
  await showPluginSettings('p1');
}

describe('plugin settings dialog', () => {
  beforeEach(() => {
    closeDynamicModal();
    document.body.innerHTML = '';
    apiCall.mockReset();
  });

  it('closes on Cancel', async () => {
    await open();
    expect(document.getElementById('dynamic-modal')).not.toBeNull();
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === 'Cancel'
    )!;
    cancel.click();
    expect(document.getElementById('dynamic-modal')).toBeNull();
  });

  it('closes on Save', async () => {
    await open();
    document
      .getElementById('plugin-settings-form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.getElementById('dynamic-modal')).toBeNull());
  });
});
