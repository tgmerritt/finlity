/**
 * Tab navigation system.
 */

import { querySelectorAll, querySelector, toggleClass } from '@/utils/html';

/**
 * Available tab names.
 */
export type TabName =
  'dashboard' | 'holdings' | 'analysis' | 'projections' | 'budget' | 'taxes' | 'settings';

/**
 * Valid tab names for runtime validation.
 */
const VALID_TABS: readonly TabName[] = [
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

/** Elements that navigate between tabs: sidebar items and bottom tab bar buttons. */
const NAV_SELECTOR = '.nav-item[data-tab], .bottom-tab[data-tab]';

/** Tabs that have their own button in the phone bottom bar. */
const BOTTOM_BAR_TABS: readonly TabName[] = ['dashboard', 'holdings', 'projections', 'budget'];

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

  // Clear the active state on every navigation element (sidebar and bottom bar).
  // Other markup also uses data-tab (install modal tabs), so stay scoped.
  const navItems = querySelectorAll<HTMLElement>(NAV_SELECTOR);
  navItems.forEach((item) => {
    const isActive = item.getAttribute('data-tab') === tabName;
    toggleClass(item, 'active', isActive);
    if (isActive) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  });

  // "More" stands in for every page that has no bottom-bar tab of its own
  const moreButton = querySelector<HTMLElement>('#bottom-tab-more');
  if (moreButton) {
    toggleClass(moreButton, 'active', !BOTTOM_BAR_TABS.includes(tabName));
  }

  // Show selected tab content
  const selectedContent = querySelector<HTMLElement>(`#tab-${tabName}`);
  if (selectedContent) {
    selectedContent.style.display = 'block';
  } else {
    console.error(`Tab content element not found: #tab-${tabName}`);
  }

  // Update current tab
  currentTab = tabName;
  document.body.classList.toggle('on-settings', tabName === 'settings');

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
 * Keep the bottom bar's More button in sync with the drawer state.
 */
function setMoreExpanded(expanded: boolean): void {
  const moreButton = querySelector<HTMLElement>('#bottom-tab-more');
  if (moreButton) {
    moreButton.setAttribute('aria-expanded', String(expanded));
  }
}

/**
 * Close mobile navigation menu.
 */
function closeMobileNav(): void {
  const sidebar = querySelector<HTMLElement>('.sidebar');
  const overlay = querySelector<HTMLElement>('.mobile-nav-overlay');
  setMoreExpanded(false);

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
    setMoreExpanded(!isOpen);

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

  // Bottom bar "More" button opens the drawer
  const moreButton = querySelector<HTMLElement>('#bottom-tab-more');
  if (moreButton) {
    moreButton.addEventListener('click', toggleMobileNav);
  }
}
