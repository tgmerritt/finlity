/**
 * Onboarding Feature
 * Handles first-visit welcome flow, demo mode, and guided tour.
 */

import { apiCall } from '@/api/client';
import { showToast } from '@/ui/toast';
import { showLoading, hideLoading } from '@/ui/loading';
import { getElementById, createSvgElement } from '@/utils/html';
import { showTab } from '@/ui/tabs';

/**
 * Demo mode status.
 */
let currentDemoMode = false;

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
 * Check if this is the user's first visit.
 */
export function isFirstVisit(): boolean {
  return !localStorage.getItem('hasVisitedBefore');
}

/**
 * Mark welcome as complete and show dashboard.
 */
export function completeWelcome(): void {
  localStorage.setItem('hasVisitedBefore', 'true');
  showTab('dashboard');
}

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

    // Show demo mode banner
    const banner = getElementById<HTMLElement>('demo-mode-banner');
    if (banner) banner.style.display = 'flex';

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
    const data = await apiCall<{ enabled: boolean }>('/api/settings/demo-mode');
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

  // Update toggle checkbox
  const toggle = getElementById<HTMLInputElement>('demo-mode-toggle');
  if (toggle) toggle.checked = isEnabled;

  // Update status badge
  const statusBadge = getElementById<HTMLElement>('demo-mode-status');
  if (statusBadge) {
    statusBadge.textContent = isEnabled ? 'Active' : 'Off';
    statusBadge.className = `status-badge ${isEnabled ? 'active' : 'inactive'}`;
  }

  // Show/hide demo mode banner
  const banner = getElementById<HTMLElement>('demo-mode-banner');
  if (banner) banner.style.display = isEnabled ? 'flex' : 'none';
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
 * Start the guided tour.
 */
export function startTour(): void {
  currentTourStep = 0;
  const overlay = getElementById<HTMLElement>('tour-overlay');
  if (overlay) overlay.style.display = 'block';

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
      const targetEl = document.querySelector(step.target);
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
  const targetEl = document.querySelector(step.target);
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
  const isMobile = viewportWidth < 768;
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
  if (overlay) overlay.style.display = 'none';

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
  if (modal) modal.style.display = 'flex';
}

/**
 * Close profile setup modal.
 */
export function closeProfileSetup(): void {
  const modal = getElementById<HTMLElement>('profile-setup-modal');
  if (modal) modal.style.display = 'none';

  // If user cancels, still mark welcome as seen and go to dashboard
  localStorage.setItem('hasVisitedBefore', 'true');
  showTab('dashboard');
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
    badge.textContent = mode === 'server' ? 'Server' : 'Local';
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
    updateStorageModeRestrictions(false, 'Unable to verify deployment environment. Using local storage for safety.');

    return null;
  }
}

/**
 * Update storage mode UI based on deployment restrictions.
 * On Heroku when demo mode is disabled, server storage is not allowed.
 */
export function updateStorageModeRestrictions(
  serverAllowed: boolean,
  reason: string | null
): void {
  const serverOption = getElementById<HTMLElement>('server-storage-option');
  const serverRadio = getElementById<HTMLInputElement>('storage-mode-server');
  const localRadio = document.querySelector<HTMLInputElement>('input[name="storage-mode"][value="local"]');
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
 * Create a new local database by resetting server data to empty state.
 * This creates a fresh portfolio without any existing positions or accounts.
 */
export async function createNewLocalDatabase(): Promise<void> {
  const confirmed = window.confirm(
    'This will create a new empty portfolio database.\n\n' +
    'Your current data will remain on the server. ' +
    'You can switch back to server mode to access it.\n\n' +
    'Continue?'
  );

  if (!confirmed) return;

  showLoading('Creating new database...');
  try {
    // Create a new profile for local storage
    await apiCall('/api/profiles', {
      method: 'POST',
      body: {
        name: `Local Profile ${new Date().toLocaleDateString()}`,
        description: 'Created for local storage mode',
      },
    });

    // Ensure local mode is selected
    setStorageMode('local');

    showToast('New database created. You can now import your data.', 'success');

    // Navigate to holdings tab to start importing
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
 * In local mode, this persists data to localStorage/IndexedDB.
 */
export async function saveLocalDatabase(): Promise<void> {
  showToast('Data is automatically saved', 'info');
}

/**
 * Download the local database as a backup file.
 */
export async function downloadLocalDatabase(): Promise<void> {
  showLoading('Preparing download...');
  try {
    // Use the existing export functionality
    const response = await fetch('/api/portfolio/export/all-csv');
    if (!response.ok) {
      throw new Error('Failed to export data');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portfolio-backup-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    showToast('Database exported successfully', 'success');
  } catch (error) {
    console.error('Error downloading database:', error);
    showToast('Failed to download database', 'error');
  } finally {
    hideLoading();
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
