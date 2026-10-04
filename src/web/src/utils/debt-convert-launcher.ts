/**
 * Opens the conversion dialog or the undo prompt from any page. The feature is
 * imported on demand, so its code (a `feature-*` chunk) loads only when someone
 * converts a property row.
 */
import { store } from '@/state/store';
import { showToast } from '@/ui/toast';
import type { LiabilityResponse } from '@/types/api';

function failed(error: unknown): void {
  console.error('Conversion dialog load failed:', error instanceof Error ? error.name : 'error');
  showToast('Could not open that. Please try again.', 'error');
}

/** Ask what the position is, show every change, and convert only after Confirm. */
export async function openDebtConvertLazy(positionId: string): Promise<void> {
  try {
    const { openDebtConvert } = await import('@/features/debt-convert');
    openDebtConvert(positionId, { entities: store.get('entities') });
  } catch (error) {
    failed(error);
  }
}

/** Ask before undoing a conversion; `onDone` runs after a successful undo. */
export async function openUndoConversionLazy(
  debt: Pick<LiabilityResponse, 'id' | 'name'>,
  onDone?: () => void
): Promise<void> {
  try {
    const { openUndoConversion } = await import('@/features/debt-convert');
    openUndoConversion(debt, onDone ? { onDone } : {});
  } catch (error) {
    failed(error);
  }
}
