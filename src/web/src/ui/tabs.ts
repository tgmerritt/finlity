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

const PHONE_QUERY = '(max-width: 768px)';
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The element that opened the drawer, so closing can hand focus back to it.
let drawerOpener: HTMLElement | null = null;
let drawerKeysBound = false;

/**
 * Whether the sidebar is currently a slide-out drawer (phone layout).
 */
function isPhoneLayout(): boolean {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(PHONE_QUERY).matches;
  }
  return window.innerWidth <= 768;
}

function isDrawerOpen(): boolean {
  return querySelector<HTMLElement>('.sidebar')?.classList.contains('mobile-open') ?? false;
}

/**
 * Keep the closed phone drawer out of the tab order and the accessibility
 * tree. `inert` does the work; aria-hidden covers browsers without it. On
 * wider layouts the sidebar is a normal visible nav and must stay reachable.
 */
function syncDrawerAvailability(): void {
  const sidebar = querySelector<HTMLElement>('.sidebar');
  if (!sidebar) return;
  if (isPhoneLayout() && !isDrawerOpen()) {
    sidebar.setAttribute('inert', '');
    sidebar.setAttribute('aria-hidden', 'true');
  } else {
    sidebar.removeAttribute('inert');
    sidebar.removeAttribute('aria-hidden');
  }
}

/**
 * Visible, enabled focusable elements inside the drawer, in DOM order.
 */
function drawerFocusables(sidebar: HTMLElement): HTMLElement[] {
  return Array.from(sidebar.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    for (
      let node: HTMLElement | null = el;
      node && node !== sidebar.parentElement;
      node = node.parentElement
    ) {
      if (node.hidden) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
}

/**
 * Escape closes the open drawer; Tab and Shift+Tab wrap inside it.
 */
function handleDrawerKeydown(event: KeyboardEvent): void {
  if (!isDrawerOpen()) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    // An open profile dropdown inside the drawer takes the first Escape.
    const dropdown = document.getElementById('profile-dropdown');
    if (dropdown?.closest('.sidebar') && getComputedStyle(dropdown).display !== 'none') {
      dropdown.style.display = 'none';
      document.getElementById('profile-selector-btn')?.focus();
      return;
    }
    closeMobileNav();
    return;
  }
  if (event.key !== 'Tab') return;
  const sidebar = querySelector<HTMLElement>('.sidebar');
  if (!sidebar) return;
  const items = drawerFocusables(sidebar);
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const active = document.activeElement;
  if (!sidebar.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
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
 * Close mobile navigation menu and return focus to the button that opened it.
 */
function closeMobileNav(restoreFocus = true): void {
  const sidebar = querySelector<HTMLElement>('.sidebar');
  const overlay = querySelector<HTMLElement>('.mobile-nav-overlay');
  const wasOpen = isDrawerOpen();
  setMoreExpanded(false);

  if (sidebar) {
    toggleClass(sidebar, 'mobile-open', false);
  }

  if (overlay) {
    overlay.style.display = 'none';
  }

  syncDrawerAvailability();

  if (wasOpen && restoreFocus) {
    const opener = drawerOpener ?? querySelector<HTMLElement>('#bottom-tab-more');
    drawerOpener = null;
    opener?.focus();
  }
}

/**
 * Toggle mobile navigation menu.
 */
export function toggleMobileNav(): void {
  const sidebar = querySelector<HTMLElement>('.sidebar');
  const overlay = querySelector<HTMLElement>('.mobile-nav-overlay');

  if (!sidebar) return;
  if (isDrawerOpen()) {
    closeMobileNav();
    return;
  }

  drawerOpener =
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : querySelector<HTMLElement>('#bottom-tab-more');
  toggleClass(sidebar, 'mobile-open', true);
  setMoreExpanded(true);
  syncDrawerAvailability();
  if (overlay) {
    overlay.style.display = 'block';
  }
  drawerFocusables(sidebar)[0]?.focus();
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
    overlay.addEventListener('click', () => closeMobileNav());
    document.body.appendChild(overlay);
  }

  // Bottom bar "More" button opens the drawer
  const moreButton = querySelector<HTMLElement>('#bottom-tab-more');
  if (moreButton) {
    moreButton.addEventListener('click', toggleMobileNav);
  }

  if (!drawerKeysBound) {
    document.addEventListener('keydown', handleDrawerKeydown);
    drawerKeysBound = true;
  }

  // Resizing across the phone breakpoint switches the sidebar between a
  // drawer and a permanent nav.
  if (typeof window.matchMedia === 'function') {
    const mql = window.matchMedia(PHONE_QUERY);
    const onBreakpointChange = (): void => {
      if (!isPhoneLayout() && isDrawerOpen()) {
        // The opener is hidden on wider layouts; keep focus in the nav instead.
        const sidebar = querySelector<HTMLElement>('.sidebar');
        const hadFocus = !!sidebar?.contains(document.activeElement);
        drawerOpener = null;
        closeMobileNav(false);
        if (hadFocus) {
          const target =
            querySelector<HTMLElement>('.sidebar .nav-item.active') ??
            querySelector<HTMLElement>('.sidebar .nav-item');
          target?.focus();
        }
      } else {
        syncDrawerAvailability();
      }
    };
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onBreakpointChange);
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(onBreakpointChange);
    }
  }
  syncDrawerAvailability();
}
