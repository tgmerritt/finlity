import { describe, it, expect, vi, beforeEach } from 'vitest';

const openSmartImportWizard = vi.fn(() => ({ modal: null }));
vi.mock('@/features/smart-import', () => ({ openSmartImportWizard }));
vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));

import { openSmartImportLazy } from '@/utils/smart-import-launcher';

describe('openSmartImportLazy', () => {
  beforeEach(() => openSmartImportWizard.mockClear());

  it('loads the wizard on demand and passes the options through', async () => {
    const files = [new File(['x'], 'a.csv')];
    const handle = await openSmartImportLazy({ files, preset: 'credit_card' });
    expect(openSmartImportWizard).toHaveBeenCalledWith({ files, preset: 'credit_card' });
    expect(handle).toEqual({ modal: null });
  });

  it('opens with no options', async () => {
    await openSmartImportLazy();
    expect(openSmartImportWizard).toHaveBeenCalledWith({});
  });
});
