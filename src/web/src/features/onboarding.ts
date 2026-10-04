/**
 * Onboarding Feature
 * Handles demo mode, and guided tour.
 */

import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { showLoading, hideLoading } from '@/ui/loading';
import { getElementById, createSvgElement } from '@/utils/html';
import { showTab } from '@/ui/tabs';
import { goToSection } from '@/ui/settings-sections';
import { emit } from '@/state/events';
import { store } from '@/state/store';
import { clientDB } from '@/database/client-database';
import { getLocalAPI } from '@/api/dispatcher';

/**
 * Demo mode status.
 */
let currentDemoMode = false;

/**
 * Whether the server blocks disabling demo mode (hosted site). Reported by
 * GET /api/settings/demo-mode as disable_locked.
 */
let demoDisableLocked = false;

/**
 * Current tour step index.
 */
let currentTourStep = 0;

/**
 * Tour step definition.
 */
interface TourStep {
  target: string;
  icon: string;
  title: string;
  content: string;
}

/**
 * Tour steps configuration.
 */
const tourSteps: TourStep[] = [
  {
    target: '[data-tab="holdings"]',
    icon: '📊',
    title: 'Import Your Data',
    content:
      'You might hold investments at different institutions (brokerage, company 401k, bank, etc.) and you need to see everything in one place. Import your portfolio data from CSV exports or add positions manually.',
  },
  {
    target: '[data-tab="settings"]',
    icon: '⚙️',
    title: 'Configure Your Profile',
    content:
      'Set up your age and retirement target so the simulation is more accurate. Configure your tax filing status and state to get precise projections.',
  },
  {
    target: '[data-tab="projections"]',
    icon: '🎯',
    title: 'Run Monte Carlo Simulations',
    content:
      'A Monte Carlo simulation evaluates future growth accounting for events like Black Swan events (market crashes) thousands of times, giving you a statistical view of the likelihood that your money will serve you for the rest of your life.',
  },
];

/**
 * Start demo mode.
 */
export async function startDemoMode(): Promise<void> {
  try {
    await apiCall('/api/settings/demo-mode', {
      method: 'PUT',
      body: { enabled: true },
    });

    localStorage.setItem('hasVisitedBefore', 'true');
    showTab('dashboard');
    document.dispatchEvent(new CustomEvent('dashboard:refreshRequested'));

    setDemoBannerVisible(true);

    showToast('Demo mode enabled! Explore with sample data.', 'success');
  } catch (error) {
    console.error('Failed to enable demo mode:', error);
    showToast('Failed to enable demo mode', 'error');
  }
}

/**
 * Check demo mode status from server.
 */
export async function checkDemoModeStatus(): Promise<boolean> {
  try {
    const data = await apiCall<{ enabled: boolean; disable_locked?: boolean }>(
      '/api/settings/demo-mode'
    );
    demoDisableLocked = data.disable_locked === true;
    store.set('demoMode', data.enabled);
    updateDemoModeUI(data.enabled);
    return data.enabled;
  } catch (error) {
    console.error('Error checking demo mode:', error);
  }
  return false;
}

/**
 * Update demo mode UI elements.
 */
export function updateDemoModeUI(isEnabled: boolean): void {
  currentDemoMode = isEnabled;

  // Update toggle checkbox. When the server locks disabling (hosted site),
  // grey out the toggle rather than letting the PUT bounce with a 403.
  // Turning demo ON is always allowed, so only lock while it is enabled.
  const locked = demoDisableLocked && isEnabled;
  const toggle = getElementById<HTMLInputElement>('demo-mode-toggle');
  if (toggle) {
    toggle.checked = isEnabled;
    toggle.disabled = locked;
  }

  const lockedHint = getElementById<HTMLElement>('demo-mode-locked-hint');
  if (lockedHint) lockedHint.classList.toggle('hidden', !locked);

  // Update status badge
  const statusBadge = getElementById<HTMLElement>('demo-mode-status');
  if (statusBadge) {
    statusBadge.textContent = isEnabled ? 'Active' : 'Off';
    statusBadge.className = `status-badge ${isEnabled ? 'active' : 'inactive'}`;
  }

  setDemoBannerVisible(isEnabled);
}

const DEMO_BANNER_DISMISSED_KEY = 'demoBannerDismissed';

/** Dismissal for this page load, used when sessionStorage is unavailable. */
let demoBannerDismissedInPage = false;

function isDemoBannerDismissed(): boolean {
  if (demoBannerDismissedInPage) return true;
  try {
    return sessionStorage.getItem(DEMO_BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The single place the demo banner is shown or hidden. A dismissed banner
 * stays hidden for the browser session even when demo mode is on. Uses the
 * .hidden class because style.css defines .hidden { display: none !important; }.
 */
function setDemoBannerVisible(show: boolean): void {
  const banner = getElementById<HTMLElement>('demo-mode-banner');
  if (banner) banner.classList.toggle('hidden', !show || isDemoBannerDismissed());
}

/**
 * Wire the demo banner's Settings link and dismiss button.
 */
export function initDemoBanner(): void {
  demoBannerDismissedInPage = false;
  getElementById<HTMLElement>('demo-banner-settings')?.addEventListener('click', () => {
    showTab('settings');
    // Demo Mode lives in Accounts & data; open it on phones, where sections collapse.
    goToSection('settings-accounts-data');
  });
  getElementById<HTMLElement>('demo-banner-dismiss')?.addEventListener('click', () => {
    demoBannerDismissedInPage = true;
    try {
      sessionStorage.setItem(DEMO_BANNER_DISMISSED_KEY, '1');
    } catch {
      // Storage blocked: the in-page flag still hides it until reload.
    }
    setDemoBannerVisible(false);
  });
}

/**
 * Toggle demo mode on/off.
 */
export async function toggleDemoMode(enabled: boolean): Promise<void> {
  try {
    showLoading(enabled ? 'Switching to demo mode...' : 'Switching to personal portfolio...');

    await apiCall('/api/settings/demo-mode', {
      method: 'PUT',
      body: { enabled },
    });

    showToast(enabled ? 'Demo mode enabled' : 'Restored personal portfolio', 'success');

    // Notify subscribers before the reload kicks in. Most listeners won't get
    // a chance to do anything async (we hard-reload below), but synchronous
    // cleanup hooks (clearing in-memory caches, etc.) can still run.
    emit({ type: 'demo:toggled', demoMode: enabled });

    // CRITICAL: Clear view ID from localStorage when switching databases
    // Views are stored per-database, so old view IDs become invalid
    localStorage.removeItem('portfolioViewId');

    // Hard reload with cache busting to ensure fresh data from new database
    const url = new URL(window.location.href);
    url.searchParams.set('_t', String(Date.now()));
    window.location.href = url.toString();
  } catch (error) {
    hideLoading();
    console.error('Error toggling demo mode:', error);
    showToast('Failed to update demo mode', 'error');

    // Revert toggle on error
    const toggle = getElementById<HTMLInputElement>('demo-mode-toggle');
    if (toggle) toggle.checked = !enabled;
  }
}

/**
 * Get current demo mode status.
 */
export function isDemoMode(): boolean {
  return currentDemoMode;
}

/**
 * Find a tour target. Tab buttons exist in both the sidebar and the phone
 * bottom bar, and only one is displayed at a time, so prefer a visible match.
 */
function findTourTarget(selector: string): HTMLElement | null {
  const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
  const visible = matches.find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return visible ?? matches[0] ?? null;
}

/**
 * Start the guided tour.
 */
export function startTour(): void {
  currentTourStep = 0;
  const overlay = getElementById<HTMLElement>('tour-overlay');
  if (overlay) {
    // `hidden` is `display:none !important`; strip it so the overlay shows.
    overlay.classList.remove('hidden');
    overlay.style.display = 'block';
  }

  showTourStep(0);

  // Add resize handler to reposition card on window resize
  window.addEventListener('resize', handleTourResize);
}

/**
 * Handle window resize during tour.
 */
function handleTourResize(): void {
  const overlay = getElementById<HTMLElement>('tour-overlay');
  if (overlay && overlay.style.display !== 'none') {
    const step = tourSteps[currentTourStep];
    if (step) {
      const targetEl = findTourTarget(step.target);
      if (targetEl instanceof HTMLElement) {
        positionTourElements(targetEl);
      }
    }
  }
}

/**
 * Show a specific tour step.
 */
export function showTourStep(stepIndex: number): void {
  const step = tourSteps[stepIndex];
  if (!step) return;

  // Update step indicator
  const indicator = getElementById<HTMLElement>('tour-step-indicator');
  if (indicator) {
    indicator.textContent = `Step ${stepIndex + 1} of ${tourSteps.length}`;
  }

  // Update content
  const iconEl = getElementById<HTMLElement>('tour-icon');
  const titleEl = getElementById<HTMLElement>('tour-title');
  const contentEl = getElementById<HTMLElement>('tour-content');

  if (iconEl) iconEl.textContent = step.icon;
  if (titleEl) titleEl.textContent = step.title;
  if (contentEl) contentEl.textContent = step.content;

  // Update button text for last step
  const nextBtn = getElementById<HTMLButtonElement>('tour-next-btn');
  if (nextBtn) {
    // Clear existing content
    while (nextBtn.firstChild) {
      nextBtn.removeChild(nextBtn.firstChild);
    }

    if (stepIndex === tourSteps.length - 1) {
      nextBtn.appendChild(document.createTextNode('Get Started '));

      // Create check icon
      const checkIcon = createSvgElement('svg');
      checkIcon.setAttribute('viewBox', '0 0 24 24');
      checkIcon.setAttribute('width', '16');
      checkIcon.setAttribute('height', '16');
      checkIcon.setAttribute('fill', 'none');
      checkIcon.setAttribute('stroke', 'currentColor');
      checkIcon.setAttribute('stroke-width', '2');

      const polyline = createSvgElement('polyline');
      polyline.setAttribute('points', '20 6 9 17 4 12');
      checkIcon.appendChild(polyline);
      nextBtn.appendChild(checkIcon);
    } else {
      nextBtn.appendChild(document.createTextNode('Next '));

      // Create arrow icon
      const arrowIcon = createSvgElement('svg');
      arrowIcon.setAttribute('viewBox', '0 0 24 24');
      arrowIcon.setAttribute('width', '16');
      arrowIcon.setAttribute('height', '16');
      arrowIcon.setAttribute('fill', 'none');
      arrowIcon.setAttribute('stroke', 'currentColor');
      arrowIcon.setAttribute('stroke-width', '2');

      const polyline = createSvgElement('polyline');
      polyline.setAttribute('points', '9 18 15 12 9 6');
      arrowIcon.appendChild(polyline);
      nextBtn.appendChild(arrowIcon);
    }
  }

  // Position spotlight and card
  const targetEl = findTourTarget(step.target);
  if (targetEl instanceof HTMLElement) {
    positionTourElements(targetEl);
  }

  // Re-trigger animation
  const card = getElementById<HTMLElement>('tour-card');
  if (card) {
    card.style.animation = 'none';
    // Trigger reflow
    void card.offsetHeight;
    card.style.animation = 'tourBounceIn 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55)';
  }
}

/**
 * Position tour elements relative to target.
 */
function positionTourElements(targetEl: HTMLElement): void {
  const rect = targetEl.getBoundingClientRect();
  const spotlight = getElementById<HTMLElement>('tour-spotlight');
  const card = getElementById<HTMLElement>('tour-card');

  if (!spotlight || !card) return;

  // Position spotlight over target
  const padding = 6;
  spotlight.style.left = rect.left - padding + 'px';
  spotlight.style.top = rect.top - padding + 'px';
  spotlight.style.width = rect.width + padding * 2 + 'px';
  spotlight.style.height = rect.height + padding * 2 + 'px';

  // Get viewport dimensions
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  // Get card dimensions (need to make it visible briefly to measure)
  card.style.visibility = 'hidden';
  card.style.display = 'block';
  const cardRect = card.getBoundingClientRect();
  const cardHeight = cardRect.height;
  const cardWidth = cardRect.width;
  card.style.visibility = 'visible';

  // Check if we're on mobile (sidebar is hidden or narrow viewport)
  const isMobile = viewportWidth <= 768;
  const sidebarWidth = isMobile ? 0 : 240; // var(--sidebar-width)

  if (isMobile) {
    // On mobile: center card horizontally, position in safe area
    const cardLeft = Math.max(16, (viewportWidth - cardWidth) / 2);
    card.style.left = cardLeft + 'px';

    // Position card in upper portion of screen with padding
    const topPosition = Math.min(100, viewportHeight * 0.15);
    card.style.top = topPosition + 'px';

    // Hide spotlight on mobile (sidebar not visible)
    spotlight.style.display = 'none';
  } else {
    // On desktop: position card to the right of sidebar
    spotlight.style.display = 'block';

    // Calculate ideal top position (aligned with target, slightly above)
    const idealTop = rect.top - 30;

    // Ensure card doesn't go above viewport (min 20px from top)
    const minTop = 20;

    // Ensure card doesn't go below viewport (20px padding from bottom)
    const maxTop = viewportHeight - cardHeight - 20;

    // Clamp the position within bounds
    const finalTop = Math.max(minTop, Math.min(idealTop, maxTop));

    // Position the card
    card.style.left = sidebarWidth + 30 + 'px';
    card.style.top = finalTop + 'px';
  }
}

/**
 * Advance to next tour step.
 */
export function nextTourStep(): void {
  currentTourStep++;
  if (currentTourStep >= tourSteps.length) {
    endTour();
    showProfileSetup();
  } else {
    showTourStep(currentTourStep);
  }
}

/**
 * End the guided tour.
 */
export function endTour(): void {
  const overlay = getElementById<HTMLElement>('tour-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.add('hidden');
  }

  localStorage.setItem('tourCompleted', 'true');

  // Remove resize handler
  window.removeEventListener('resize', handleTourResize);
}

/**
 * Skip tour and go directly to profile setup.
 */
export function skipTour(): void {
  endTour();
  showProfileSetup();
}

/**
 * Show profile setup modal.
 */
export function showProfileSetup(): void {
  const modal = getElementById<HTMLElement>('profile-setup-modal');
  if (modal) {
    // `hidden` is `display:none !important`; strip it so the modal shows.
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  }
}

/**
 * Close profile setup modal.
 */
export function closeProfileSetup(): void {
  const modal = getElementById<HTMLElement>('profile-setup-modal');
  if (modal) modal.style.display = 'none';

  // If user cancels, still mark the app as visited and go to the dashboard
  localStorage.setItem('hasVisitedBefore', 'true');
  showTab('dashboard');
  document.dispatchEvent(new CustomEvent('dashboard:refreshRequested'));
}

/**
 * Select storage mode option (visual update only).
 */
export function selectStorageMode(mode: 'server' | 'local'): void {
  // Update visual selection
  document.querySelectorAll('.radio-option').forEach((opt) => {
    opt.classList.remove('selected');
    const input = opt.querySelector<HTMLInputElement>(`input[value="${mode}"]`);
    if (input) {
      opt.classList.add('selected');
      input.checked = true;
    }
  });
}

/**
 * Set storage mode (called from HTML onclick handlers).
 * Updates localStorage, UI badge, and shows/hides local storage options.
 */
export function setStorageMode(mode: 'server' | 'local'): void {
  // Save to localStorage
  localStorage.setItem('storageMode', mode);

  // Update badge
  const badge = getElementById<HTMLElement>('storage-mode-badge');
  if (badge) {
    badge.textContent = mode === 'server' ? 'Backend' : 'Browser';
    badge.className = `badge ${mode}`;
  }

  // Show/hide local storage options
  const localOptions = getElementById<HTMLElement>('local-storage-options');
  if (localOptions) {
    localOptions.style.display = mode === 'local' ? 'block' : 'none';
  }

  // Update Settings page radio selection (uses :checked CSS)
  const serverRadio = getElementById<HTMLInputElement>('storage-mode-server');
  const localRadio = getElementById<HTMLInputElement>('storage-mode-local');
  if (serverRadio) serverRadio.checked = mode === 'server';
  if (localRadio) localRadio.checked = mode === 'local';

  // Also update Profile modal .radio-option selection (uses .selected class)
  document.querySelectorAll('.radio-option').forEach((opt) => {
    const input = opt.querySelector<HTMLInputElement>('input[name="storage-mode"]');
    if (input) {
      const isSelected = input.value === mode;
      opt.classList.toggle('selected', isSelected);
      input.checked = isSelected;
    }
  });

  console.debug(`Storage mode set to: ${mode}`);
}

/**
 * Deployment info from server.
 */
interface DeploymentInfo {
  is_heroku: boolean;
  demo_mode: boolean;
  server_storage_allowed: boolean;
  server_storage_reason: string | null;
}

/**
 * Load deployment information from server.
 * Used to determine if storage restrictions apply (Heroku non-demo mode).
 * On failure, defaults to blocking server storage for safety.
 */
export async function loadDeploymentInfo(): Promise<DeploymentInfo | null> {
  try {
    const info = await apiCall<DeploymentInfo>('/api/settings/deployment-info');
    updateStorageModeRestrictions(info.server_storage_allowed, info.server_storage_reason);
    return info;
  } catch (error) {
    console.error('Failed to load deployment info:', error);

    // Notify user about the failure
    showToast(
      'Unable to determine deployment settings. Storage mode may be restricted.',
      'warning'
    );

    // SAFETY: On failure, assume server storage is NOT allowed to prevent data loss
    // This ensures users don't accidentally store personal data on ephemeral storage
    updateStorageModeRestrictions(
      false,
      'Unable to verify deployment environment. Using local storage for safety.'
    );

    return null;
  }
}

/**
 * Update storage mode UI based on deployment restrictions.
 * On Heroku when demo mode is disabled, server storage is not allowed.
 */
export function updateStorageModeRestrictions(serverAllowed: boolean, reason: string | null): void {
  const serverOption = getElementById<HTMLElement>('server-storage-option');
  const serverRadio = getElementById<HTMLInputElement>('storage-mode-server');
  const localRadio = document.querySelector<HTMLInputElement>(
    'input[name="storage-mode"][value="local"]'
  );
  const banner = getElementById<HTMLElement>('heroku-storage-banner');
  const message = getElementById<HTMLElement>('heroku-storage-message');

  if (!serverAllowed) {
    // Disable server option
    if (serverOption) serverOption.classList.add('disabled');
    if (serverRadio) serverRadio.disabled = true;

    // Show warning banner
    if (banner) banner.style.display = 'flex';
    if (message && reason) message.textContent = reason;

    // Auto-select local mode if server was selected
    if (localRadio && serverRadio?.checked) {
      setStorageMode('local');
    }
  } else {
    // Enable server option
    if (serverOption) serverOption.classList.remove('disabled');
    if (serverRadio) serverRadio.disabled = false;

    // Hide warning banner
    if (banner) banner.style.display = 'none';
  }
}

/**
 * Check if tour has been completed.
 */
export function isTourCompleted(): boolean {
  return localStorage.getItem('tourCompleted') === 'true';
}

/**
 * F2: guard against silently discarding unsaved work. openFile()/
 * importFromFile()/createNew() all unconditionally overwrite whatever
 * database is currently open in clientDB with no dirty check of their own
 * (see client-database.ts:178,311,201-210) — callers at the UI layer are
 * expected to confirm with the user first. Returns true if it's safe to
 * proceed (nothing open, nothing unsaved, or the user confirmed), false if
 * the caller should abort.
 */
function confirmDiscardUnsavedChanges(): boolean {
  if (!clientDB.isOpen() || !clientDB.getStorageInfo().isDirty) return true;
  return window.confirm(
    'You have unsaved changes that will be lost if you continue. Continue anyway?'
  );
}

/**
 * Create a new, empty local database in the browser (clientDB).
 *
 * REWRITTEN for hosted/local mode: previously this created a server-side
 * profile via POST /api/profiles, which no longer applies now that user
 * data lives entirely in the browser SQLite DB (see
 * src/database/client-database.ts). Any existing in-memory data is
 * discarded — the caller is expected to have confirmed with the user
 * (see the boot-gate modal in ensureLocalDatabaseReady, or the Settings
 * page action that calls this directly).
 */
export async function createNewLocalDatabase(): Promise<void> {
  if (!confirmDiscardUnsavedChanges()) return;

  showLoading('Creating new database...');
  try {
    clientDB.close();
    await clientDB.createNew();
    // F1(b): persist immediately so storageMode flips to 'indexeddb' and
    // auto-save (started right below) actually has somewhere to write.
    // createNew() alone leaves storageMode as 'memory', under which
    // ClientDatabase.startAutoSave()'s interval is a no-op — without this,
    // data entered here would only ever be saved if the user happened to
    // trigger a manual "Save to browser storage" action.
    await clientDB.saveToIndexedDB();
    startClientDbAutoSave();
    showToast('New database created. You can now import your data.', 'success');
    showTab('holdings');
  } catch (error) {
    console.error('Error creating new database:', error);
    showToast('Failed to create new database: ' + (error as Error).message, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Save the current local database state.
 *
 * REWRITTEN for hosted/local mode: delegates to clientDB.saveToFile() (File
 * System Access API when the DB was opened/saved as a file) or, when no
 * file handle exists yet, falls back to a browser download so the data is
 * never silently unsaved.
 */
export async function saveLocalDatabase(): Promise<void> {
  if (!clientDB.isOpen()) {
    showToast('No database is open', 'warning');
    return;
  }

  const info = clientDB.getStorageInfo();
  if (info.mode === 'indexeddb') {
    // IndexedDB auto-save already persists on the interval started by
    // startClientDbAutoSave(); a manual save just forces it immediately.
    try {
      await clientDB.saveToIndexedDB();
      showToast('Saved to browser storage', 'success');
    } catch (error) {
      console.error('Error saving to IndexedDB:', error);
      showToast('Failed to save to browser storage', 'error');
    }
    return;
  }

  try {
    const result = await clientDB.saveToFile();
    if (result.status === 'saved') {
      showToast(`Saved to ${result.name}`, 'success');
    } else if (result.status === 'downloaded') {
      showToast(`Downloaded ${result.name}`, 'success');
    } else if (result.status === 'failed') {
      showToast(`Failed to save: ${result.error}`, 'error');
    }
    // 'cancelled' — user dismissed the save-as picker, no toast needed.
  } catch (error) {
    console.error('Error saving database:', error);
    showToast('Failed to save database', 'error');
  }
}

/**
 * Download the local database as a .db file.
 *
 * REWRITTEN for hosted/local mode: previously concatenated server CSV
 * export endpoints into one file. The local database IS the backup now, so
 * this downloads the raw SQLite file via clientDB.downloadDatabase()
 * instead.
 */
export function downloadLocalDatabase(): void {
  if (!clientDB.isOpen()) {
    showToast('No database is open', 'warning');
    return;
  }
  try {
    const timestamp = new Date().toISOString().split('T')[0];
    clientDB.downloadDatabase(`portfolio-backup-${timestamp}.db`);
    showToast('Database downloaded successfully', 'success');
  } catch (error) {
    console.error('Error downloading database:', error);
    showToast('Failed to download database', 'error');
  }
}

/**
 * Open an existing local database (.db/.sqlite file) using a file picker.
 *
 * REWRITTEN for hosted/local mode: previously only handled CSV via the
 * import flow. Now opens real SQLite database files into clientDB via the
 * File System Access API (Chrome/Edge) when available, falling back to a
 * plain file input (importFromFile) otherwise. CSV files are still routed
 * to the existing import flow for backwards compatibility.
 */
export function openLocalDatabase(): void {
  if (!confirmDiscardUnsavedChanges()) return;

  if (clientDB.hasFileSystemAccess()) {
    clientDB
      .openFile()
      .then((result) => {
        if (!result) return; // user cancelled
        startClientDbAutoSave();
        showToast(`Opened ${result.name}`, 'success');
        document.dispatchEvent(new CustomEvent('dashboard:refreshRequested'));
      })
      .catch((error) => {
        console.error('Error opening database file:', error);
        showToast('Failed to open database file', 'error');
      });
    return;
  }

  // Fallback: plain file input (no File System Access API support).
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.db,.sqlite,.sqlite3';
  input.style.display = 'none';

  input.addEventListener('change', async (e) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    showLoading(`Opening ${file.name}...`);
    try {
      if (file.name.endsWith('.csv')) {
        // Trigger the import modal with this file
        const importModal = getElementById<HTMLElement>('import-modal');
        if (importModal) {
          importModal.style.display = 'flex';
        }

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);

        const importFileInput = document.getElementById('import-file') as HTMLInputElement | null;
        if (importFileInput) {
          importFileInput.files = dataTransfer.files;
          importFileInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        showToast('File loaded. Review the import preview and confirm.', 'info');
      } else {
        const result = await clientDB.importFromFile(file);
        startClientDbAutoSave();
        showToast(`Opened ${result.name}`, 'success');
        document.dispatchEvent(new CustomEvent('dashboard:refreshRequested'));
      }
    } catch (error) {
      console.error('Error opening database:', error);
      showToast('Failed to open database file', 'error');
    } finally {
      hideLoading();
    }

    document.body.removeChild(input);
  });

  document.body.appendChild(input);
  input.click();
}

/**
 * Load portfolio data from browser storage (IndexedDB).
 *
 * REWRITTEN for hosted/local mode: previously read a JSON blob from
 * localStorage. Now delegates to clientDB.loadFromIndexedDB(), which loads
 * the real SQLite database saved there.
 */
export async function loadFromBrowserStorage(): Promise<void> {
  showLoading('Loading from browser storage...');
  try {
    const result = await clientDB.loadFromIndexedDB();
    if (!result.loaded) {
      showToast('No saved data found in browser storage', 'warning');
      return;
    }
    startClientDbAutoSave();
    showToast('Loaded database from browser storage', 'success');
    document.dispatchEvent(new CustomEvent('dashboard:refreshRequested'));
  } catch (error) {
    console.error('Error loading from browser storage:', error);
    showToast('Browser storage data is corrupted', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Save current database to browser storage (IndexedDB).
 *
 * REWRITTEN for hosted/local mode: previously fetched accounts/positions
 * from the server API and stringified them into localStorage. Now saves
 * the real SQLite database (all tables) into IndexedDB via clientDB.
 */
export async function saveToBrowserStorage(): Promise<void> {
  if (!clientDB.isOpen()) {
    showToast('No database is open', 'warning');
    return;
  }
  showLoading('Saving to browser storage...');
  try {
    await clientDB.saveToIndexedDB();
    startClientDbAutoSave();
    showToast('Saved database to browser storage', 'success');
  } catch (error) {
    console.error('Error saving to browser storage:', error);
    showToast('Failed to save data to browser storage', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Clear all portfolio data from browser storage (IndexedDB).
 *
 * REWRITTEN for hosted/local mode: previously removed a localStorage key.
 * Now clears the IndexedDB-persisted SQLite database via clientDB.
 */
export function clearBrowserStorage(): void {
  const confirmed = window.confirm(
    'This will permanently delete all portfolio data stored in your browser.\n\n' +
      'This action cannot be undone.\n\n' +
      'Continue?'
  );

  if (!confirmed) return;

  clientDB
    .clearIndexedDB()
    .then(() => showToast('Browser storage cleared', 'success'))
    .catch((error) => {
      console.error('Error clearing browser storage:', error);
      showToast('Failed to clear browser storage', 'error');
    });
}

// =====================================================================
// Hosted-mode boot gate (dataMode === 'local')
// =====================================================================

/** Auto-save interval for the unsaved-changes header indicator (ms). Matches clientDB's default. */
const AUTO_SAVE_INTERVAL_MS = 30000;
/** Interval for polling clientDB.isDirty() to refresh the header indicator (ms). */
const DIRTY_INDICATOR_POLL_MS = 5000;

let dirtyIndicatorInterval: ReturnType<typeof setInterval> | null = null;
let beforeUnloadHandlerInstalled = false;

/**
 * Start clientDB's auto-save (only actually persists in IndexedDB mode —
 * see ClientDatabase.startAutoSave), the unsaved-changes header indicator,
 * and the beforeunload warning. Safe to call multiple times (idempotent).
 */
export function startClientDbAutoSave(): void {
  clientDB.startAutoSave(AUTO_SAVE_INTERVAL_MS);
  clientDB.setAutoSaveFailureCallback((failCount) => {
    showToast(
      `Auto-save to browser storage failed ${failCount} times in a row. Download a backup to avoid losing data.`,
      'error'
    );
  });

  if (!dirtyIndicatorInterval) {
    dirtyIndicatorInterval = setInterval(updateUnsavedChangesIndicator, DIRTY_INDICATOR_POLL_MS);
  }
  updateUnsavedChangesIndicator();

  if (!beforeUnloadHandlerInstalled) {
    window.addEventListener('beforeunload', (event) => {
      if (clientDB.isOpen() && clientDB.getStorageInfo().isDirty) {
        event.preventDefault();
        // Modern browsers ignore custom messages, but setting returnValue
        // is still required to trigger the confirmation prompt at all.
        event.returnValue = true;
      }
    });
    beforeUnloadHandlerInstalled = true;
  }
}

/**
 * Update the "unsaved changes" indicator in the header, if present in the
 * markup. Uses `#unsaved-changes-indicator`; hidden by the `hidden` utility
 * class when there is nothing unsaved.
 */
function updateUnsavedChangesIndicator(): void {
  const indicator = getElementById<HTMLElement>('unsaved-changes-indicator');
  if (!indicator) return;
  const isDirty = clientDB.isOpen() && clientDB.getStorageInfo().isDirty;
  indicator.classList.toggle('hidden', !isDirty);
}

/**
 * Build and show the blocking "open or create a database" modal used by
 * ensureLocalDatabaseReady() when no database is open yet (first visit,
 * IndexedDB has nothing saved, or - see C3 - a storage failure occurred
 * while checking/loading IndexedDB). Unlike ui/modal.ts's
 * createDynamicModal, this modal has no close/cancel/backdrop/Escape
 * dismissal — the app has no data source until the user picks one, so it
 * must be answered.
 *
 * @param errorNotice - When set (C3 recovery path), renders an error banner
 * above the description and adds a "Start fresh" button that clears
 * IndexedDB before creating a new database — for the case where existing
 * IndexedDB data can't be read/loaded, so the user isn't stuck retrying the
 * same failing load.
 *
 * Resolves once a database is open (never rejects).
 */
function showDatabaseGateModal(errorNotice?: string): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop db-gate-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '10000';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    const card = document.createElement('div');
    card.className = 'modal-content db-gate-card';
    card.style.maxWidth = '480px';
    card.style.width = '90%';

    const title = document.createElement('h2');
    title.textContent = 'Open or create your portfolio database';
    card.appendChild(title);

    if (errorNotice) {
      const errorBanner = document.createElement('div');
      errorBanner.className = 'db-gate-error-notice';
      errorBanner.setAttribute('role', 'alert');
      errorBanner.style.color = 'var(--color-danger, #dc2626)';
      errorBanner.style.marginBottom = '0.5rem';
      errorBanner.textContent = errorNotice;
      card.appendChild(errorBanner);
    }

    const description = document.createElement('p');
    description.className = 'form-help';
    description.textContent =
      'Your data stays in this browser — nothing is sent to or stored on the server. ' +
      'Choose how you want to get started.';
    card.appendChild(description);

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'button-group';
    buttonGroup.style.flexDirection = 'column';
    buttonGroup.style.gap = '0.75rem';
    buttonGroup.style.marginTop = '1rem';

    const finish = (): void => {
      overlay.remove();
      resolve();
    };

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-primary';
    openBtn.textContent = clientDB.hasFileSystemAccess()
      ? 'Open existing .db file'
      : 'Open existing .db file (upload)';
    openBtn.addEventListener('click', async () => {
      openBtn.disabled = true;
      try {
        if (clientDB.hasFileSystemAccess()) {
          const result = await clientDB.openFile();
          if (!result) {
            openBtn.disabled = false;
            return; // user cancelled the file picker — stay on the gate
          }
        } else {
          const opened = await promptForFileUpload();
          if (!opened) {
            openBtn.disabled = false;
            return;
          }
        }
        finish();
      } catch (error) {
        console.error('Failed to open database file:', error);
        showToast('Failed to open database file', 'error');
        openBtn.disabled = false;
      }
    });
    buttonGroup.appendChild(openBtn);

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'btn btn-secondary';
    createBtn.textContent = 'Create new database';
    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      try {
        await clientDB.createNew();
        // F1(b): persist immediately and switch to 'indexeddb' storage mode
        // so auto-save (started right after this modal resolves, in
        // ensureLocalDatabaseReady) is active from the very first keystroke
        // instead of leaving the new database in non-persisting 'memory'
        // mode until the user happens to trigger a save. This makes
        // "Create new database" behaviorally identical to the "Continue
        // with browser storage" button below; both are kept as distinct,
        // clearly-labeled entry points since users take this path from
        // different mental models (starting a database vs. picking a
        // storage location).
        await clientDB.saveToIndexedDB();
        finish();
      } catch (error) {
        console.error('Failed to create new database:', error);
        showToast('Failed to create new database', 'error');
        createBtn.disabled = false;
      }
    });
    buttonGroup.appendChild(createBtn);

    const browserBtn = document.createElement('button');
    browserBtn.type = 'button';
    browserBtn.className = 'btn btn-text';
    browserBtn.textContent = 'Continue with browser storage (new database, auto-saved)';
    browserBtn.addEventListener('click', async () => {
      browserBtn.disabled = true;
      try {
        await clientDB.createNew();
        await clientDB.saveToIndexedDB();
        finish();
      } catch (error) {
        console.error('Failed to initialize browser storage:', error);
        showToast('Failed to initialize browser storage', 'error');
        browserBtn.disabled = false;
      }
    });
    buttonGroup.appendChild(browserBtn);

    // C3 recovery action: only shown when the gate is presented because an
    // existing IndexedDB read/load failed (errorNotice set) rather than
    // because there was simply nothing saved yet. Clears the (apparently
    // corrupted/unreadable) IndexedDB data before creating a fresh database,
    // so the user has a way forward instead of being stuck re-attempting a
    // load that will keep failing.
    if (errorNotice) {
      const startFreshBtn = document.createElement('button');
      startFreshBtn.type = 'button';
      startFreshBtn.className = 'btn btn-text';
      startFreshBtn.textContent = 'Start fresh (clears browser storage)';
      startFreshBtn.addEventListener('click', async () => {
        startFreshBtn.disabled = true;
        try {
          await clientDB.clearIndexedDB();
          await clientDB.createNew();
          await clientDB.saveToIndexedDB();
          finish();
        } catch (error) {
          console.error('Failed to start fresh:', error);
          showToast('Failed to reset browser storage', 'error');
          startFreshBtn.disabled = false;
        }
      });
      buttonGroup.appendChild(startFreshBtn);
    }

    card.appendChild(buttonGroup);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  });
}

/**
 * Fallback file picker for browsers without the File System Access API.
 * Resolves true if a file was loaded into clientDB, false if cancelled.
 */
function promptForFileUpload(): Promise<boolean> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.db,.sqlite,.sqlite3';
    input.style.display = 'none';

    input.addEventListener('change', async (e) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      document.body.removeChild(input);
      if (!file) {
        resolve(false);
        return;
      }
      try {
        await clientDB.importFromFile(file);
        resolve(true);
      } catch (error) {
        console.error('Failed to import database file:', error);
        showToast('Failed to open database file', 'error');
        resolve(false);
      }
    });

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Ensure a local database is open before the app proceeds, in hosted/local
 * mode (dataMode === 'local'). Called from main.ts's init() before any
 * feature/page initialization runs.
 *
 * - If IndexedDB already has a saved database, load it silently.
 * - Otherwise, block on a modal asking the user to open an existing .db
 *   file, create a new one, or continue with auto-saved browser storage.
 *
 * Starts auto-save (appropriate to whichever storage mode was chosen) once
 * a database is open, then takes an initial snapshot so the dashboard
 * history chart has at least one data point.
 */
export async function ensureLocalDatabaseReady(): Promise<void> {
  await clientDB.init();

  // C3: hasIndexedDBData()/loadFromIndexedDB() now reject (rather than
  // hang) on a genuine storage failure (see C1/C2 fixes in
  // client-database.ts). Catch that here so a corrupted/unreadable
  // IndexedDB never leaves the user on a stuck loading screen — instead,
  // show the same gate modal with an error notice and a "Start fresh"
  // recovery action (in addition to the normal open/create options).
  try {
    const hasSaved = await clientDB.hasIndexedDBData();
    if (hasSaved) {
      await clientDB.loadFromIndexedDB();
    } else {
      await showDatabaseGateModal();
    }
  } catch (error) {
    console.error('Failed to read local browser storage:', error);
    await showDatabaseGateModal(
      'Could not read your saved data from browser storage. You can open a database file, ' +
        'start fresh, or create a new database.'
    );
  }

  // Hosted demo site: a newcomer's fresh browser DB is empty, which made
  // the showcase land on $0 despite the server running demo.db. Seed it
  // from the server's read-only demo export (no-op unless demo mode is
  // locked on AND the local DB has no accounts yet).
  await seedDemoDatasetIfEmpty();

  startClientDbAutoSave();

  // Baseline snapshot so history/allocation charts have data on first load,
  // matching the server's behavior of snapshotting after each mutation
  // (here we just ensure at least one point exists at boot).
  try {
    getLocalAPI().takeSnapshot();
  } catch (error) {
    console.warn('Could not take initial snapshot:', error);
  }
}

/**
 * Seed a freshly-created local DB with the server's demo dataset when the
 * hosted site runs in locked demo mode. Preserves the server's row IDs so
 * positions/snapshots stay referentially coherent; skips entirely when the
 * visitor already has data (never overwrites a real portfolio). Failures
 * degrade to a warning — worst case the visitor sees the empty-DB flow,
 * exactly the pre-seeding behavior.
 */
export async function seedDemoDatasetIfEmpty(): Promise<boolean> {
  try {
    const status = await apiCall<{ enabled?: boolean; disable_locked?: boolean }>(
      '/api/settings/demo-mode'
    );
    if (!(status.enabled && status.disable_locked)) return false;

    const existing = clientDB.query<{ n: number }>('SELECT COUNT(*) AS n FROM accounts');
    if ((existing[0]?.n ?? 0) > 0) return false;

    const data = await apiCall<{
      entities: Array<Record<string, unknown>>;
      accounts: Array<Record<string, unknown>>;
      positions: Array<Record<string, unknown>>;
      snapshots: Array<Record<string, unknown>>;
      liabilities?: Array<Record<string, unknown>>;
      liability_snapshots?: Array<Record<string, unknown>>;
    }>('/api/settings/demo-mode/export');

    if (!data.accounts?.length) return false;

    // All-or-nothing: a throw partway must not leave a half-seeded database
    // for autosave to persist (the visitor would then never be reseeded).
    clientDB.execute('BEGIN');
    try {
      for (const e of data.entities ?? []) {
        clientDB.execute(
          `INSERT OR IGNORE INTO entities (id, name, entity_type, is_default, is_household, color, icon)
         VALUES (?, ?, ?, 0, 0, ?, ?)`,
          [e.id, e.name, e.entity_type, e.color ?? '#4A90D9', e.icon ?? 'user']
        );
      }
      for (const a of data.accounts) {
        clientDB.execute(
          `INSERT OR IGNORE INTO accounts (id, entity_id, name, account_type, brokerage, beneficiary, custom_type_name, is_retirement_account)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            a.id,
            a.entity_id ?? null,
            a.name,
            a.account_type,
            a.brokerage ?? 'other',
            a.beneficiary ?? null,
            a.custom_type_name ?? null,
            a.is_retirement_account ? 1 : 0,
          ]
        );
      }
      for (const p of data.positions) {
        clientDB.execute(
          `INSERT OR IGNORE INTO positions (id, account_id, ticker, name, shares, cost_basis, current_price, sector, is_fund, asset_class, position_type, maturity_date, interest_rate, purchase_date, option_underlying, option_expiration, option_strike, option_type, contract_multiplier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            p.id,
            p.account_id,
            p.ticker,
            p.name ?? null,
            p.shares,
            p.cost_basis ?? null,
            p.current_price ?? null,
            p.sector ?? null,
            p.is_fund ? 1 : 0,
            p.asset_class ?? 'equity',
            p.position_type ?? 'equity',
            p.maturity_date ?? null,
            p.interest_rate ?? null,
            p.purchase_date ?? null,
            p.option_underlying ?? null,
            p.option_expiration ?? null,
            p.option_strike ?? null,
            p.option_type ?? null,
            p.contract_multiplier ?? null,
          ]
        );
      }
      for (const s of data.snapshots ?? []) {
        clientDB.execute(
          `INSERT OR IGNORE INTO portfolio_snapshots (id, snapshot_date, total_value, retirement_value, taxable_value, positions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            s.id,
            s.snapshot_date,
            s.total_value,
            s.retirement_value,
            s.taxable_value,
            s.positions_json,
            s.created_at,
          ]
        );
      }

      // Calendar days only: the table CHECKs length 10, so slice any datetime.
      const day = (v: unknown): string | null =>
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
      // The household entity is not exported (the browser makes its own), so
      // only keep entity ids that were seeded. expense_id is cleared: the
      // server's budget expenses are not seeded here.
      const seeded = new Set((data.entities ?? []).map((e) => e.id));
      for (const l of data.liabilities ?? []) {
        if (!day(l.balance_as_of)) continue; // required column, row unusable
        clientDB.execute(
          `INSERT OR IGNORE INTO liabilities (id, entity_id, name, liability_type, lender, current_balance, balance_as_of, interest_rate, payment_amount, payment_frequency, next_payment_date, escrow_amount, original_principal, origination_date, term_months, maturity_date, credit_limit, is_amortizing, linked_position_id, expense_id, source, source_ref, source_detail, is_active, closed_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            l.id,
            seeded.has(l.entity_id) ? l.entity_id : null,
            l.name,
            l.liability_type,
            l.lender ?? null,
            l.current_balance,
            day(l.balance_as_of),
            l.interest_rate ?? null,
            l.payment_amount ?? null,
            l.payment_frequency ?? 'monthly',
            day(l.next_payment_date),
            l.escrow_amount ?? null,
            l.original_principal ?? null,
            day(l.origination_date),
            l.term_months ?? null,
            day(l.maturity_date),
            l.credit_limit ?? null,
            l.is_amortizing ? 1 : 0,
            l.linked_position_id ?? null,
            null,
            l.source ?? 'demo',
            l.source_ref ?? null,
            l.source_detail ?? null,
            l.is_active === 0 || l.is_active === false ? 0 : 1,
            day(l.closed_date),
            l.notes ?? null,
          ]
        );
      }
      for (const s of data.liability_snapshots ?? []) {
        if (!day(s.snapshot_date)) continue;
        clientDB.execute(
          `INSERT OR IGNORE INTO liability_balance_snapshots (id, liability_id, snapshot_date, balance, source, source_ref)
         VALUES (?, ?, ?, ?, ?, ?)`,
          [
            s.id,
            s.liability_id,
            day(s.snapshot_date),
            s.balance,
            s.source ?? 'demo',
            s.source_ref ?? null,
          ]
        );
      }

      clientDB.execute('COMMIT');
    } catch (seedError) {
      try {
        clientDB.execute('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw seedError;
    }

    await clientDB.saveToIndexedDB();
    console.log(
      `Seeded demo dataset locally: ${data.accounts.length} accounts, ${data.positions.length} positions`
    );
    return true;
  } catch (error) {
    console.warn('Demo dataset seeding skipped:', error);
    return false;
  }
}

/**
 * Initialize onboarding features.
 */
export function initOnboarding(): void {
  // Set up tour button handlers
  const nextBtn = getElementById<HTMLButtonElement>('tour-next-btn');
  if (nextBtn) {
    nextBtn.addEventListener('click', nextTourStep);
  }

  const skipBtn = getElementById<HTMLButtonElement>('tour-skip-btn');
  if (skipBtn) {
    skipBtn.addEventListener('click', skipTour);
  }

  initDemoBanner();

  // Set up demo mode toggle
  const demoToggle = getElementById<HTMLInputElement>('demo-mode-toggle');
  if (demoToggle) {
    demoToggle.addEventListener('change', () => {
      toggleDemoMode(demoToggle.checked);
    });
  }

  // Set up storage mode radio buttons
  document.querySelectorAll<HTMLInputElement>('input[name="storage-mode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      selectStorageMode(radio.value as 'server' | 'local');
    });
  });

  console.debug('Onboarding initialized');
}
