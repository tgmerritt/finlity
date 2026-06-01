/**
 * Main entry point for the Finlity frontend application.
 * Initializes all modules and sets up the application.
 */

// Core state and session
import { initSession } from '@/state/session';
import { initTheme, toggleTheme, setTheme } from '@/state/theme';

// UI components
import { initTabs, initMobileNav, showTab, toggleMobileNav, onTabChange } from '@/ui/tabs';
import type { TabName } from '@/ui/tabs';
import { showToast, showError } from '@/ui/toast';
import { hideLoading, showLoading } from '@/ui/loading';
import {
  showModal,
  closeModal,
  initModal,
  showTriggerModal,
  hideTriggerModal,
  closeBudgetModal,
} from '@/ui/modal';

// API client
import { apiCall } from '@/api/client';

// Charts
import {
  updateAllocationCharts,
  updateHistoryChart,
  setHistoryTimeRange,
} from '@/charts/allocation';

// Pages
import {
  initDashboard,
  refreshData as refreshDashboardData,
  loadRetirementMetrics,
  checkForDuplicates,
  refreshPrices,
  showDuplicateDetails,
  autoRefreshIfStale,
  updatePriceStatus,
} from '@/pages/dashboard';
import {
  initHoldings,
  updateHoldings,
  sortPositions,
  sortHoldings,
  selectAllAccounts,
  toggleMultiSelect,
  showAddPositionModal,
  hideAddPositionModal,
  showEditPositionModal,
  hideEditPositionModal,
  showNewAccountForm,
  createNewAccount,
  addManualPosition,
  filterHoldings,
  togglePositionTypeFields,
  updatePosition,
} from '@/pages/holdings';
import {
  initAnalysis,
  analyzeFund,
  sendStreamingChatMessage,
  sendGlobalChatMessage,
  showGlobalChat,
  hideGlobalChat,
  getAdvisorAnalysis,
  analyzePortfolioFunds,
  updatePositionSectors,
  enrichAllData,
  updateEnrichmentStatus,
  clearGlobalChat,
  loadAnalysisData,
  showMetricDetail,
  showAllocationTab,
  loadTopHoldings,
  showTopHoldingsDetail,
} from '@/pages/analysis';
import {
  initProjections,
  runProjection,
  calculateFire,
  loadTaxesTab,
  runTaxProjection,
  loadAccountBalancesByType,
  toggleTaxAwareSettings,
  toggleConfigPanel,
  updateMonteCarloConfigSummary,
} from '@/pages/projections';
import {
  initBudget,
  showBudgetTab,
  loadBudgetTab,
  showAddIncomeModal,
  showAddExpenseModal,
  showAddDeductionModal,
  runTransitionProjection,
  updateBudgetCalc,
} from '@/pages/budget';
import { initBankStatementUpload, acceptRecurringCandidate, rejectRecurringCandidate } from '@/features/bank-statements';
import {
  initSettings,
  loadAIProviders,
  loadApiKeysStatus,
  loadViewsList,
  loadAccountsManagement,
  showCreateViewModal,
  hideViewModal,
  loadEntitiesList,
  showCreateEntityModal,
  hideEntityModal,
  editEntity,
  saveEntity,
  setDefaultEntity,
  deleteEntity,
  runAutoDetectEntities,
  onAIModelChange,
  onAIProviderChange,
  saveAssetClassTargets,
  saveMarketAssumptions,
  saveMonteCarloSettings,
  savePersonalSettings,
  saveView,
} from '@/pages/settings';

// Features
import {
  initProfiles,
  loadProfiles,
  updateProfileDisplay,
  switchProfile,
  showManageProfilesModal,
  toggleProfileDropdown,
  showCreateProfileModal,
  hideProfileModal,
  saveProfile,
  importProfileFromFile,
  handleProfileImport,
} from '@/features/profiles';
import {
  initEntitySelector,
  loadEntities,
  changeEntity,
  autoDetectEntities,
} from '@/features/entities';
import {
  loadViews,
  changeView,
  initViewSelector,
} from '@/features/views';
import { initCommentary, initAICommentaryButtons, showAICommentary } from '@/features/commentary';
import {
  initPlugins,
  loadPlugins,
  loadInstalledPlugins,
  loadPluginSecurity,
  loadWidgets,
  loadPluginAnalysis,
  showInstallPluginModal,
  hideInstallPluginModal,
  switchInstallTab,
  checkPluginUpdates,
  discoverPlugins,
  handlePluginFileSelect,
  installFromGit,
  installFromUpload,
} from '@/features/plugins';
import {
  initImportExport,
  exportToCSV,
  exportAllToCSV,
  confirmImport as confirmImportWithCallback,
  hideImportModal,
  showImportNewAccountForm,
  createImportAccount,
  browseExistingDatabase,
  handleFileSelect,
  handleDragOver,
  handleDragLeave,
  handleFileDrop,
  toggleAllImportPositions,
} from '@/features/import-export';
import {
  initOnboarding,
  isFirstVisit,
  startDemoMode,
  checkDemoModeStatus,
  toggleDemoMode,
  startTour,
  nextTourStep,
  endTour,
  showProfileSetup,
  closeProfileSetup,
  completeWelcome,
  selectStorageMode,
  setStorageMode,
  loadDeploymentInfo,
  updateStorageModeRestrictions,
  createNewLocalDatabase,
  saveLocalDatabase,
  downloadLocalDatabase,
  openLocalDatabase,
  loadFromBrowserStorage,
  saveToBrowserStorage,
  clearBrowserStorage,
} from '@/features/onboarding';
import { initSocialFeed, destroySocialFeed, refreshSocialFeed } from '@/features/social-feed';

// Utilities
import { formatCurrency, formatPercent, formatNumber } from '@/utils/format';
import { escapeHtml } from '@/utils/html';

// Re-export commonly used functions for global access during transition
export {
  formatCurrency,
  formatPercent,
  formatShares,
  formatPrice,
  formatNumber,
} from '@/utils/format';
export { showToast, showSuccess, showError, showWarning, showInfo } from '@/ui/toast';
export { showLoading, hideLoading, withLoading } from '@/ui/loading';
export { showTab, getCurrentTab } from '@/ui/tabs';
export { showModal, closeModal } from '@/ui/modal';
export { apiCall, runAsyncApiCall, getBaseUrl } from '@/api/client';
export { store, get, set } from '@/state/store';
export { isDarkMode, toggleTheme, getChartColors } from '@/state/theme';
export {
  renderChart,
  createPieChartData,
  createLineChartData,
  createBarChartData,
} from '@/charts/plotly-utils';


/**
 * Populate age-related form fields across all pages from saved personal settings.
 * Falls back to HTML defaults (35/65) if no settings are saved.
 */
async function populateAgeFromSettings(): Promise<void> {
  try {
    const data = await apiCall<{ personal?: {
      dob?: string;
      retirement_age?: number;
    } }>('/api/settings/config/personal');

    if (!data?.personal) return;

    const p = data.personal;

    // Calculate current age from DOB
    let currentAge: number | null = null;
    if (p.dob) {
      const dob = new Date(p.dob + 'T00:00:00');
      const today = new Date();
      currentAge = today.getFullYear() - dob.getFullYear();
      const monthDiff = today.getMonth() - dob.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
        currentAge--;
      }
    }

    const retirementAge = p.retirement_age || null;

    // All current-age input IDs across pages
    const ageFields = ['current-age', 'tax-current-age', 'transition-current-age'];
    // All retirement-age input IDs across pages
    const retireFields = ['retirement-age', 'tax-retirement-age', 'transition-retirement-age'];

    if (currentAge !== null && currentAge > 0) {
      for (const id of ageFields) {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.value = String(currentAge);
      }
    }

    if (retirementAge !== null) {
      for (const id of retireFields) {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.value = String(retirementAge);
      }
    }
  } catch (error) {
    // Non-critical — fields keep their HTML defaults
    console.warn('Could not load personal settings for age fields:', error);
  }
}

/**
 * Newest settings `updated_at` (ISO 8601) we have already loaded into memory.
 * `null` until the first sync. Compared lexicographically against the server's
 * current version — both come from the same server clock, so there is no
 * client/server skew to account for (the classic "is my cached copy stale?"
 * check, done with a cheap version probe rather than a full refetch).
 */
let knownSettingsVersion: string | null = null;

/** Tabs whose displayed values derive from saved settings (age, targets, etc.). */
const SETTINGS_DEPENDENT_TABS: ReadonlySet<TabName> = new Set<TabName>([
  'dashboard',
  'analysis',
  'projections',
  'budget',
  'taxes',
]);

/**
 * Fetch the server's current settings version (newest config `updated_at`).
 * Returns null on error or when no config has been saved yet.
 */
async function fetchSettingsVersion(): Promise<string | null> {
  try {
    const r = await apiCall<{ updated_at: string | null }>('/api/settings/version');
    return r.updated_at ?? null;
  } catch (error) {
    console.warn('Could not check settings version:', error);
    return null;
  }
}

/**
 * Record the current server settings version as "seen" without refreshing.
 * Used after we have just loaded (or just saved) settings so a later navigation
 * does not treat our own up-to-date copy as stale.
 */
async function syncSettingsVersion(): Promise<void> {
  knownSettingsVersion = await fetchSettingsVersion();
}

/**
 * Cheap freshness check run on navigation to a settings-dependent page.
 *
 * Compares our in-memory settings version against the database's newest
 * `updated_at`. If the database is newer — settings changed since we last
 * loaded them (another browser tab, another profile, a prior session) — our
 * cached values are out of date, so we re-pull settings into the page inputs
 * (notably the age fields, which otherwise silently keep their defaults) and
 * tell the user. Returns true when a refresh occurred.
 */
async function refreshSettingsIfStale(): Promise<boolean> {
  const serverVersion = await fetchSettingsVersion();
  if (serverVersion === null) return false;

  // First sighting: establish the baseline, nothing to refresh yet.
  if (knownSettingsVersion === null) {
    knownSettingsVersion = serverVersion;
    return false;
  }

  // Our copy is current (or somehow newer) — no work to do.
  if (serverVersion <= knownSettingsVersion) return false;

  // Database is newer: our in-memory settings are stale. Pull them in.
  knownSettingsVersion = serverVersion;
  await populateAgeFromSettings();
  showToast('Settings refreshed', 'info');
  return true;
}

/**
 * Refresh all portfolio data.
 */
export async function refreshData(): Promise<void> {
  showLoading('Refreshing data...');
  try {
    await refreshDashboardData();
    await loadRetirementMetrics();
    initAICommentaryButtons();
  } finally {
    hideLoading();
  }
}

/**
 * Wrapper for confirmImport that provides the refreshData callback.
 * Used by HTML onclick handlers.
 */
export async function confirmImport(): Promise<void> {
  await confirmImportWithCallback(refreshData);
}

/**
 * Initialize sidebar collapse state.
 */
function initSidebarState(): void {
  const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && collapsed) {
    sidebar.classList.add('collapsed');
  }

  // Set up toggle button
  const toggleBtn = document.getElementById('sidebar-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) {
        sidebar.classList.toggle('collapsed');
        localStorage.setItem('sidebarCollapsed', String(sidebar.classList.contains('collapsed')));
      }
    });
  }
}

/**
 * Initialize storage mode preference.
 */
function initStorageMode(): void {
  const mode = localStorage.getItem('storageMode') || 'server';

  // Update badge
  const badge = document.getElementById('storage-mode-badge');
  if (badge) {
    badge.textContent = mode === 'server' ? 'Backend' : 'Browser';
    badge.className = `badge ${mode}`;
  }

  // Update radio buttons to reflect stored state
  const serverRadio = document.getElementById('storage-mode-server') as HTMLInputElement | null;
  const localRadio = document.querySelector<HTMLInputElement>(
    'input[name="storage-mode"][value="local"]'
  );
  if (serverRadio) serverRadio.checked = mode === 'server';
  if (localRadio) localRadio.checked = mode === 'local';

  // Show/hide local storage options based on stored mode
  const localOptions = document.getElementById('local-storage-options');
  if (localOptions) {
    localOptions.style.display = mode === 'local' ? 'block' : 'none';
  }
}

/**
 * Initialize collapsible config panels.
 */
function initConfigPanels(): void {
  document.querySelectorAll('.config-header').forEach((header) => {
    header.addEventListener('click', () => {
      const panel = header.closest('.config-panel');
      if (panel) {
        panel.classList.toggle('expanded');
      }
    });
  });
}

/**
 * Initialize the application.
 */
async function init(): Promise<void> {
  console.log('Finlity: Initializing application...');

  // Initialize theme first (no network required)
  initTheme();

  // Initialize UI components
  initTabs();
  initMobileNav();
  initModal();
  initSidebarState();
  initStorageMode();
  initConfigPanels();

  // Initialize session (for multi-user mode)
  await initSession();

  // Initialize features
  initProfiles();
  await initEntitySelector();
  await initViewSelector();
  initCommentary();
  initPlugins();
  initImportExport();
  initOnboarding();
  initSocialFeed();

  // Initialize pages
  initDashboard();
  initHoldings();
  initAnalysis();
  initProjections();
  initBudget();
  initBankStatementUpload();
  initSettings();

  // Listen for holdings refresh requests (from position CRUD operations)
  document.addEventListener('holdings:refreshRequested', () => {
    refreshData().catch(console.error);
  });

  // Listen for dashboard refresh requests (e.g., first-visit onboarding landing on dashboard)
  document.addEventListener('dashboard:refreshRequested', () => {
    refreshData().catch(console.error);
  });

  // Re-populate age fields when personal settings are saved, and advance our
  // known settings version so navigating away and back doesn't flag our own
  // just-saved change as "stale" and show a spurious refresh toast.
  document.addEventListener('settings:personalUpdated', () => {
    populateAgeFromSettings().then(syncSettingsVersion).catch(console.error);
  });

  // On navigation to a settings-dependent page, cheaply verify our in-memory
  // settings are still current and re-pull them if the database is newer.
  onTabChange((tab) => {
    if (SETTINGS_DEPENDENT_TABS.has(tab)) {
      refreshSettingsIfStale().catch(console.error);
    }
  });

  // Load initial data
  showLoading('Loading portfolio...');
  try {
    await loadProfiles();
    await populateAgeFromSettings();
    // Record the baseline settings version so the per-tab freshness check has
    // something to compare against (and doesn't toast on the very first visit).
    await syncSettingsVersion();
    // Fire-and-forget: can take 30s+ when upstream price APIs are slow/flaky.
    // Keeps the UI interactive while stale prices refresh in the background.
    autoRefreshIfStale().then(updatePriceStatus).catch(console.warn);
    await updatePriceStatus();
    await checkDemoModeStatus();
    await loadDeploymentInfo();

    // Show welcome tab for first-time visitors
    const firstVisit = isFirstVisit();
    if (firstVisit) {
      showTab('welcome');
    } else {
      showTab('dashboard');
      await refreshData();
    }
  } catch (error) {
    console.error('Initialization error:', error);
    showError('Failed to initialize application');
  } finally {
    hideLoading();
  }

  console.log('Finlity: Application initialized');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    init().catch((error) => {
      console.error('Fatal initialization error:', error);
      showError('Application failed to initialize. Please refresh the page.');
    });
  });
} else {
  init().catch((error) => {
    console.error('Fatal initialization error:', error);
    showError('Application failed to initialize. Please refresh the page.');
  });
}

// Expose key functions to window for HTML onclick handlers
// Using 'any' type for finlity to avoid maintaining duplicate type definitions
declare global {
  interface Window {
    finlity: Record<string, unknown>;
  }
}

// Set up global access for HTML onclick handlers
window.finlity = {
  // Navigation
  showTab,
  refreshData,
  toggleTheme,
  setTheme,
  toggleMobileNav,

  // UI Modals
  showModal,
  closeModal,
  showToast,
  showTriggerModal,
  hideTriggerModal,
  showAddTriggerModal: showTriggerModal,
  hideAddTriggerModal: hideTriggerModal,
  closeBudgetModal,

  // Dashboard
  checkForDuplicates,
  refreshPrices,
  showDuplicateDetails,

  // Holdings
  updateHoldings,
  sortPositions,
  sortHoldings,
  selectAllAccounts,
  toggleMultiSelect,
  showAddPositionModal,
  hideAddPositionModal,
  showEditPositionModal,
  hideEditPositionModal,
  showNewAccountForm,
  createNewAccount,
  addManualPosition,
  filterHoldings,
  togglePositionTypeFields,
  updatePosition,

  // Analysis
  analyzeFund,
  sendStreamingChatMessage,
  sendGlobalChatMessage,
  showGlobalChat,
  hideGlobalChat,
  getAdvisorAnalysis,
  analyzePortfolioFunds,
  updatePositionSectors,
  enrichAllData,
  updateEnrichmentStatus,
  clearGlobalChat,
  loadAnalysisData,
  showMetricDetail,
  showAllocationTab,
  showAICommentary,
  loadTopHoldings,
  showTopHoldingsDetail,

  // Projections
  runProjection,
  calculateFire,
  loadTaxesTab,
  runTaxProjection,
  loadAccountBalancesByType,
  toggleTaxAwareSettings,
  toggleConfigPanel,
  updateMonteCarloConfigSummary,

  // Budget
  showBudgetTab,
  loadBudgetTab,
  showAddIncomeModal,
  showAddExpenseModal,
  showAddDeductionModal,
  runTransitionProjection,
  updateBudgetCalc,
  acceptRecurringCandidate,
  rejectRecurringCandidate,

  // Settings
  loadAIProviders,
  loadApiKeysStatus,
  loadViewsList,
  loadAccountsManagement,
  showCreateViewModal,
  hideViewModal,
  loadEntitiesList,
  showCreateEntityModal,
  hideEntityModal,
  editEntity,
  saveEntity,
  setDefaultEntity,
  deleteEntity,
  runAutoDetectEntities,
  onAIModelChange,
  onAIProviderChange,
  saveAssetClassTargets,
  saveMarketAssumptions,
  saveMonteCarloSettings,
  savePersonalSettings,
  saveView,

  // Profiles
  loadProfiles,
  switchProfile,
  updateProfileDisplay,
  showManageProfilesModal,
  toggleProfileDropdown,
  showCreateProfileModal,
  hideProfileModal,
  createProfile: saveProfile,
  saveProfile,
  importProfileFromFile,
  handleProfileImport,

  // Entities (multi-person household tracking)
  loadEntities,
  changeEntity,
  autoDetectEntities,

  // Views (portfolio filters)
  loadViews,
  changeView,

  // Plugins
  loadPlugins,
  loadInstalledPlugins,
  loadPluginSecurity,
  loadWidgets,
  loadPluginAnalysis,
  showInstallPluginModal,
  hideInstallPluginModal,
  switchInstallTab,
  checkPluginUpdates,
  discoverPlugins,
  handlePluginFileSelect,
  installFromGit,
  installFromUpload,

  // Import/Export
  exportToCSV,
  exportAllToCSV,
  confirmImport,
  hideImportModal,
  showImportNewAccountForm,
  createImportAccount,
  browseExistingDatabase,
  handleFileSelect,
  handleDragOver,
  handleDragLeave,
  handleFileDrop,
  toggleAllImportPositions,

  // Onboarding
  startDemoMode,
  toggleDemoMode,
  startTour,
  nextTourStep,
  endTour,
  showProfileSetup,
  closeProfileSetup,
  completeWelcome,
  selectStorageMode,
  setStorageMode,
  loadDeploymentInfo,
  updateStorageModeRestrictions,
  createNewLocalDatabase,
  saveLocalDatabase,
  downloadLocalDatabase,
  openLocalDatabase,
  loadFromBrowserStorage,
  saveToBrowserStorage,
  clearBrowserStorage,

  // Social Feed
  initSocialFeed,
  destroySocialFeed,
  refreshSocialFeed,

  // Charts
  updateAllocationCharts,
  updateHistoryChart,
  setHistoryTimeRange,

  // Utilities
  formatCurrency,
  formatPercent,
  formatNumber,
  escapeHtml,
};

// Also expose all finlity functions directly on window for HTML onclick handlers
Object.assign(window, window.finlity);
(window as unknown as Record<string, unknown>).acceptRecurringCandidate = acceptRecurringCandidate;
(window as unknown as Record<string, unknown>).rejectRecurringCandidate = rejectRecurringCandidate;