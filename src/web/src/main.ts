/**
 * Main entry point for the Finlity frontend application.
 * Initializes all modules and sets up the application.
 */

import { initSession } from '@/state/session';
import { initTheme } from '@/state/theme';
import { store } from '@/state/store';
import { initTabs, initMobileNav, showTab } from '@/ui/tabs';
import { showError, showWarning } from '@/ui/toast';
import { hideLoading, showLoading } from '@/ui/loading';
import { apiCall } from '@/api/client';
import type { DashboardData, Profile, PortfolioView } from '@/types/api';

// Re-export commonly used functions for global access during transition
export { formatCurrency, formatPercent, formatShares, formatPrice } from '@/utils/format';
export { showToast, showSuccess, showError, showWarning, showInfo } from '@/ui/toast';
export { showLoading, hideLoading, withLoading } from '@/ui/loading';
export { showTab, getCurrentTab } from '@/ui/tabs';
export { apiCall, runAsyncApiCall } from '@/api/client';
export { store, get, set } from '@/state/store';
export { isDarkMode, toggleTheme, getChartColors } from '@/state/theme';
export {
  renderChart,
  createPieChartData,
  createLineChartData,
  createBarChartData,
} from '@/charts/plotly-utils';

/**
 * Check if this is the user's first visit.
 */
function isFirstVisit(): boolean {
  return !localStorage.getItem('hasVisitedBefore');
}

/**
 * Load profiles from the API.
 * Failures are logged and shown to user - app continues with limited functionality.
 */
async function loadProfiles(): Promise<void> {
  try {
    const profiles = await apiCall<Profile[]>('/api/profiles');
    store.set('profiles', profiles);

    const activeProfile = profiles.find((p) => p.is_active);
    if (activeProfile) {
      store.set('activeProfileId', activeProfile.id);
    }
  } catch (error) {
    console.error('Failed to load profiles:', error);
    showWarning('Unable to load profiles. Some features may be limited.');
  }
}

/**
 * Load portfolio views from the API.
 * Failures are logged and shown to user - app continues with limited functionality.
 */
async function loadViews(): Promise<void> {
  try {
    const views = await apiCall<PortfolioView[]>('/api/portfolio/views');
    store.set('availableViews', views);
  } catch (error) {
    console.error('Failed to load views:', error);
    showWarning('Unable to load portfolio views.');
  }
}

/**
 * Load dashboard data from the API.
 */
async function loadDashboardData(): Promise<void> {
  try {
    const viewId = store.get('currentViewId');
    const endpoint = viewId ? `/api/dashboard/data?view_id=${viewId}` : '/api/dashboard/data';

    const data = await apiCall<DashboardData>(endpoint);

    store.update({
      currentPositions: data.positions,
      portfolioHistory: data.history,
      accounts: data.summary.accounts,
      demoMode: data.demo_mode,
    });
  } catch (error) {
    console.error('Failed to load dashboard data:', error);
    showError('Failed to load portfolio data');
  }
}

/**
 * Refresh all data.
 */
export async function refreshData(): Promise<void> {
  showLoading('Refreshing data...');
  try {
    await Promise.all([loadDashboardData(), loadProfiles(), loadViews()]);
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
}

/**
 * Check and display demo mode status.
 * Failures are logged - users should know if data mode is uncertain.
 */
async function checkDemoModeStatus(): Promise<void> {
  try {
    const response = await apiCall<{ demo_mode: boolean }>('/api/settings/demo-mode');
    store.set('demoMode', response.demo_mode);

    const banner = document.getElementById('demo-mode-banner');
    if (banner) {
      banner.style.display = response.demo_mode ? 'flex' : 'none';
    }
  } catch (error) {
    console.error('Failed to check demo mode:', error);
    // Show warning since user should know if demo mode status is unknown
    showWarning('Unable to verify data mode. Status unknown.');
  }
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
  initSidebarState();

  // Initialize session (for multi-user mode)
  await initSession();

  // Load initial data
  showLoading('Loading portfolio...');
  try {
    await Promise.all([loadProfiles(), loadViews(), checkDemoModeStatus()]);

    // Show welcome tab for first-time visitors
    if (isFirstVisit()) {
      showTab('welcome');
    } else {
      showTab('dashboard');
      await loadDashboardData();
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
      showTab: typeof showTab;
      refreshData: typeof refreshData;
      toggleTheme: typeof import('@/state/theme').toggleTheme;
    };
  }
}

// Set up global access
import { toggleTheme } from '@/state/theme';

window.finlity = {
  showTab,
  refreshData,
  toggleTheme,
};
