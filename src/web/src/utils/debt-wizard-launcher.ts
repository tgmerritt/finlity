/**
 * Opens the debt wizard from any page. The wizard is imported on demand, so its
 * code (a `feature-*` chunk) loads only when someone adds a debt.
 */
import { store } from '@/state/store';
import { showToast } from '@/ui/toast';
import type { DebtWizardHandle, OpenDebtWizardOptions } from '@/features/debt-wizard';

export async function openDebtWizardLazy(
  options: OpenDebtWizardOptions = {}
): Promise<DebtWizardHandle | null> {
  try {
    const { openDebtWizard } = await import('@/features/debt-wizard');
    return openDebtWizard({ entities: store.get('entities'), ...options });
  } catch (error) {
    console.error('Debt wizard load failed:', error instanceof Error ? error.name : 'error');
    showToast('Could not open the debt wizard. Please try again.', 'error');
    return null;
  }
}
