/**
 * Main entry point for the Finlity frontend application.
 * Initializes all modules and sets up the application.
 */

// Core state and session
import { initSession } from '@/state/session';
import { initTheme, toggleTheme } from '@/state/theme';
import { store } from '@/state/store';

// UI components
import { initTabs, initMobileNav, showTab } from '@/ui/tabs';
import { showToast, showError, showWarning } from '@/ui/toast';
import { hideLoading, showLoading } from '@/ui/loading';
import { showModal, closeModal, initModal } from '@/ui/modal';

// API client
import { apiCall } from '@/api/client';

// Types
import type { PortfolioView } from '@/types/api';

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
} from '@/pages/dashboard';
import { initHoldings, updateHoldings, sortPositions } from '@/pages/holdings';
import {
  initAnalysis,
  analyzeFund,
  sendStreamingChatMessage,
  showGlobalChat,
  hideGlobalChat,
} from '@/pages/analysis';
import {
  initProjections,
  runProjection,
  calculateFire,
  loadTaxesTab,
  runTaxProjection,
} from '@/pages/projections';
import { initBudget, showBudgetTab, loadBudgetTab } from '@/pages/budget';
import {
  initSettings,
  loadAIProviders,
  loadApiKeysStatus,
  loadViewsList,
  loadAccountsManagement,
} from '@/pages/settings';

// Features
import {
  initProfiles,
  loadProfiles,
  updateProfileDisplay,
  switchProfile,
} from '@/features/profiles';
import { initCommentary, initAICommentaryButtons } from '@/features/commentary';
import {
  initPlugins,
  loadPlugins,
  loadInstalledPlugins,
  loadPluginSecurity,
  loadWidgets,
  loadPluginAnalysis,
} from '@/features/plugins';
import {
  initImportExport,
  exportToCSV,
  exportAllToCSV,
  confirmImport,
  hideImportModal,
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
} from '@/features/onboarding';

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
 * Load portfolio views from the API.
 */
async function loadViews(): Promise<void> {
  try {
    const views = await apiCall<PortfolioView[]>('/api/settings/views');
    store.set('availableViews', views);
  } catch (error) {
    console.error('Failed to load views:', error);
    showWarning('Unable to load portfolio views.');
  }
}

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
  initCommentary();
  initPlugins();
  initImportExport();
  initOnboarding();

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
    await loadViews();
    await updatePriceStatus();
    await checkDemoModeStatus();

    // Show welcome tab for first-time visitors
    if (isFirstVisit()) {
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

// Expose key functions to window for HTML onclick handlers during transition
// These will be removed once all event handlers are migrated to TypeScript
declare global {
  interface Window {
    finlity: {
      // Navigation
      showTab: typeof showTab;
      refreshData: typeof refreshData;
      toggleTheme: typeof toggleTheme;

      // UI
      showModal: typeof showModal;
      closeModal: typeof closeModal;
      showToast: typeof showToast;

      // Dashboard
      checkForDuplicates: typeof checkForDuplicates;

      // Holdings
      updateHoldings: typeof updateHoldings;
      sortPositions: typeof sortPositions;

      // Analysis
      analyzeFund: typeof analyzeFund;
      sendStreamingChatMessage: typeof sendStreamingChatMessage;
      showGlobalChat: typeof showGlobalChat;
      hideGlobalChat: typeof hideGlobalChat;

      // Projections
      runProjection: typeof runProjection;
      calculateFire: typeof calculateFire;
      loadTaxesTab: typeof loadTaxesTab;
      runTaxProjection: typeof runTaxProjection;

      // Budget
      showBudgetTab: typeof showBudgetTab;
      loadBudgetTab: typeof loadBudgetTab;

      // Settings
      loadAIProviders: typeof loadAIProviders;
      loadApiKeysStatus: typeof loadApiKeysStatus;
      loadViewsList: typeof loadViewsList;
      loadAccountsManagement: typeof loadAccountsManagement;

      // Profiles
      loadProfiles: typeof loadProfiles;
      switchProfile: typeof switchProfile;
      updateProfileDisplay: typeof updateProfileDisplay;

      // Plugins
      loadPlugins: typeof loadPlugins;
      loadInstalledPlugins: typeof loadInstalledPlugins;
      loadPluginSecurity: typeof loadPluginSecurity;
      loadWidgets: typeof loadWidgets;
      loadPluginAnalysis: typeof loadPluginAnalysis;

      // Import/Export
      exportToCSV: typeof exportToCSV;
      exportAllToCSV: typeof exportAllToCSV;
      confirmImport: typeof confirmImport;
      hideImportModal: typeof hideImportModal;

      // Onboarding
      startDemoMode: typeof startDemoMode;
      toggleDemoMode: typeof toggleDemoMode;
      startTour: typeof startTour;
      nextTourStep: typeof nextTourStep;
      endTour: typeof endTour;
      showProfileSetup: typeof showProfileSetup;
      closeProfileSetup: typeof closeProfileSetup;

      // Charts
      updateAllocationCharts: typeof updateAllocationCharts;
      updateHistoryChart: typeof updateHistoryChart;
      setHistoryTimeRange: typeof setHistoryTimeRange;

      // Utilities
      formatCurrency: typeof formatCurrency;
      formatPercent: typeof formatPercent;
      formatNumber: typeof formatNumber;
      escapeHtml: typeof escapeHtml;
    };
  }
}

// Set up global access for HTML onclick handlers
window.finlity = {
  // Navigation
  showTab,
  refreshData,
  toggleTheme,

  // UI
  showModal,
  closeModal,
  showToast,

  // Dashboard
  checkForDuplicates,

  // Holdings
  updateHoldings,
  sortPositions,

  // Analysis
  analyzeFund,
  sendStreamingChatMessage,
  showGlobalChat,
  hideGlobalChat,

  // Projections
  runProjection,
  calculateFire,
  loadTaxesTab,
  runTaxProjection,

  // Budget
  showBudgetTab,
  loadBudgetTab,

  // Settings
  loadAIProviders,
  loadApiKeysStatus,
  loadViewsList,
  loadAccountsManagement,

  // Profiles
  loadProfiles,
  switchProfile,
  updateProfileDisplay,

  // Plugins
  loadPlugins,
  loadInstalledPlugins,
  loadPluginSecurity,
  loadWidgets,
  loadPluginAnalysis,

  // Import/Export
  exportToCSV,
  exportAllToCSV,
  confirmImport,
  hideImportModal,

  // Onboarding
  startDemoMode,
  toggleDemoMode,
  startTour,
  nextTourStep,
  endTour,
  showProfileSetup,
  closeProfileSetup,

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
