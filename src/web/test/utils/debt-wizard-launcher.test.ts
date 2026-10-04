import { describe, it, expect, vi } from 'vitest';

const openDebtWizard = vi.fn();
vi.mock('@/features/debt-wizard', () => ({ openDebtWizard }));
vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));

import { openDebtWizardLazy } from '@/utils/debt-wizard-launcher';
import { store } from '@/state/store';

describe('openDebtWizardLazy', () => {
  it('loads the wizard on demand and hands it the entities', async () => {
    store.set('entities', [{ id: 'p1' }] as never);
    await openDebtWizardLazy({ onSaved: () => undefined });
    expect(openDebtWizard).toHaveBeenCalledTimes(1);
    expect(openDebtWizard.mock.calls[0]![0]).toMatchObject({ entities: [{ id: 'p1' }] });
  });
});
