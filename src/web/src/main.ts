/**
 * Main entry point for the Finlity frontend application.
 * Initializes all modules and sets up the application.
 */

// Core state and session
import { initSession } from '@/state/session';
import { initTheme, toggleTheme } from '@/state/theme';

// UI components
import { initTabs, initMobileNav, showTab, toggleMobileNav } from '@/ui/tabs';
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
} from '@/pages/holdings';
import {
  initAnalysis,
  analyzeFund,
  sendStreamingChatMessage,
  showGlobalChat,
  hideGlobalChat,
  getAdvisorAnalysis,
  analyzePortfolioFunds,
  updatePositionSectors,
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
} from '@/pages/projections';
import {
  initBudget,
  showBudgetTab,
  loadBudgetTab,
  showAddIncomeModal,
  showAddExpenseModal,
  showAddDeductionModal,
  runTransitionProjection,
} from '@/pages/budget';
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
} from '@/features/plugins';
import {
  initImportExport,
  exportToCSV,
  exportAllToCSV,
  confirmImport,
  hideImportModal,
  showImportNewAccountForm,
  createImportAccount,
  browseExistingDatabase,
  handleFileSelect,
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
 * Update price status display.
 */
async function updatePriceStatus(): Promise<void> {
  try {
    const data = await apiCall<{ last_update: string | null; prices_stale: boolean }>(
      '/api/imports/price-status'
    );
    const statusEl = document.getElementById('price-status');
    if (statusEl && data.last_update) {
      const lastUpdate = new Date(data.last_update);
      const timeStr = lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      statusEl.textContent = data.prices_stale
        ? `Prices from ${timeStr} (stale)`
        : `Prices as of ${timeStr}`;
      statusEl.className = data.prices_stale ? 'price-status stale' : 'price-status';
    }
  } catch (error) {
    console.error('Failed to check price status:', error);
  }
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
  const badge = document.getElementById('storage-mode-badge');
  if (badge) {
    badge.textContent = mode === 'server' ? 'Server' : 'Local';
    badge.className = `badge ${mode}`;
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
  initSettings();

  // Load initial data
  showLoading('Loading portfolio...');
  try {
    await loadProfiles();
    await updatePriceStatus();
    await checkDemoModeStatus();

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

  // Analysis
  analyzeFund,
  sendStreamingChatMessage,
  showGlobalChat,
  hideGlobalChat,
  getAdvisorAnalysis,
  analyzePortfolioFunds,
  updatePositionSectors,
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

  // Budget
  showBudgetTab,
  loadBudgetTab,
  showAddIncomeModal,
  showAddExpenseModal,
  showAddDeductionModal,
  runTransitionProjection,

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

  // Import/Export
  exportToCSV,
  exportAllToCSV,
  confirmImport,
  hideImportModal,
  showImportNewAccountForm,
  createImportAccount,
  browseExistingDatabase,
  handleFileSelect,

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
