/**
 * Opens the statement import wizard from any page. The wizard (and its sample
 * statements) is imported on demand, so its code loads only when someone imports.
 */
import { showToast } from '@/ui/toast';
import type { OpenSmartImportOptions, SmartImportHandle } from '@/features/smart-import';

export async function openSmartImportLazy(
  options: OpenSmartImportOptions = {}
): Promise<SmartImportHandle | null> {
  try {
    const { openSmartImportWizard } = await import('@/features/smart-import');
    return openSmartImportWizard(options);
  } catch (error) {
    console.error('Import wizard load failed:', error instanceof Error ? error.name : 'error');
    showToast('Could not open the import wizard. Please try again.', 'error');
    return null;
  }
}
