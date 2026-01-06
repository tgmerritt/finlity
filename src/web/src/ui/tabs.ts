/**
 * Tab navigation system.
 */

import { querySelectorAll, querySelector, toggleClass } from '@/utils/html';

/**
 * Available tab names.
 */
export type TabName =
  | 'welcome'
  | 'dashboard'
  | 'holdings'
  | 'analysis'
  | 'projections'
  | 'budget'
  | 'taxes'
  | 'settings';

/**
 * Valid tab names for runtime validation.
 */
const VALID_TABS: readonly TabName[] = [
  'welcome',
  'dashboard',
  'holdings',
  'analysis',
  'projections',
  'budget',
  'taxes',
  'settings',
];

/**
 * Check if a string is a valid tab name.
 */
function isValidTab(tab: string | null): tab is TabName {
  return tab !== null && VALID_TABS.includes(tab as TabName);
}

/**
 * Current active tab.
 */
let currentTab: TabName = 'dashboard';

/**
 * Tab change callbacks.
 */
const tabChangeCallbacks: ((tab: TabName) => void)[] = [];

/**
 * Show a specific tab.
 * @param tabName - Name of tab to show
 */
export function showTab(tabName: TabName): void {
  // Hide all tab contents
  const contents = querySelectorAll<HTMLElement>('.tab-content');
  contents.forEach((content) => {
    content.style.display = 'none';
  });

  // Remove active class from all nav items
  const navItems = querySelectorAll<HTMLElement>('.nav-item');
  navItems.forEach((item) => {
    toggleClass(item, 'active', false);
  });

  // Show selected tab content
  const selectedContent = querySelector<HTMLElement>(`#tab-${tabName}`);
  if (selectedContent) {
    selectedContent.style.display = 'block';
  }

  // Add active class to selected nav item
  const selectedNav = querySelector<HTMLElement>(`[data-tab="${tabName}"]`);
  if (selectedNav) {
    toggleClass(selectedNav, 'active', true);
  }

  // Update current tab
  currentTab = tabName;

  // Notify callbacks
  tabChangeCallbacks.forEach((callback) => callback(tabName));

  // Close mobile nav if open
  closeMobileNav();
}

/**
 * Get the current active tab.
 * @returns Current tab name
 */
export function getCurrentTab(): TabName {
  return currentTab;
}

/**
 * Register a callback for tab changes.
 * @param callback - Function to call when tab changes
 * @returns Unsubscribe function
 */
export function onTabChange(callback: (tab: TabName) => void): () => void {
  tabChangeCallbacks.push(callback);
  return () => {
    const index = tabChangeCallbacks.indexOf(callback);
    if (index > -1) {
      tabChangeCallbacks.splice(index, 1);
    }
  };
}

/**
 * Initialize tab navigation event handlers.
 */
export function initTabs(): void {
  // Add click handlers to nav items
  const navItems = querySelectorAll<HTMLElement>('.nav-item[data-tab]');
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const tabName = item.getAttribute('data-tab');
      // Validate tab name at runtime to prevent invalid navigation
      if (isValidTab(tabName)) {
        showTab(tabName);
      } else {
        console.warn(`Invalid tab name in data-tab attribute: ${tabName}`);
      }
    });
  });
}

/**
 * Close mobile navigation menu.
 */
function closeMobileNav(): void {
  const sidebar = querySelector<HTMLElement>('.sidebar');
  const overlay = querySelector<HTMLElement>('.mobile-nav-overlay');

  if (sidebar) {
    toggleClass(sidebar, 'mobile-open', false);
  }

  if (overlay) {
    overlay.style.display = 'none';
  }
}

/**
 * Toggle mobile navigation menu.
 */
export function toggleMobileNav(): void {
  const sidebar = querySelector<HTMLElement>('.sidebar');
  const overlay = querySelector<HTMLElement>('.mobile-nav-overlay');

  if (sidebar) {
    const isOpen = sidebar.classList.contains('mobile-open');
    toggleClass(sidebar, 'mobile-open', !isOpen);

    if (overlay) {
      overlay.style.display = !isOpen ? 'block' : 'none';
    }
  }
}

/**
 * Initialize mobile navigation.
 */
export function initMobileNav(): void {
  // Create mobile nav overlay if it doesn't exist
  let overlay = querySelector<HTMLElement>('.mobile-nav-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'mobile-nav-overlay';
    overlay.addEventListener('click', closeMobileNav);
    document.body.appendChild(overlay);
  }

  // Add click handler to mobile menu button
  const menuButton = querySelector<HTMLElement>('.mobile-menu-btn');
  if (menuButton) {
    menuButton.addEventListener('click', toggleMobileNav);
  }
}
