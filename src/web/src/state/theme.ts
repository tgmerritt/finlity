/**
 * Theme management for dark/light mode.
 */

const THEME_KEY = 'theme';

export type Theme = 'dark' | 'light';

/**
 * Get the current theme.
 * @returns Current theme
 */
export function getTheme(): Theme {
  return (document.documentElement.getAttribute('data-theme') as Theme) || 'dark';
}

/**
 * Check if dark mode is active.
 * @returns True if dark mode
 */
export function isDarkMode(): boolean {
  return getTheme() === 'dark';
}

/**
 * Set the theme.
 * @param theme - Theme to set
 */
export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);

  // Dispatch event for components that need to react to theme changes
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

/**
 * Toggle between dark and light themes.
 * @returns The new theme
 */
export function toggleTheme(): Theme {
  const newTheme = isDarkMode() ? 'light' : 'dark';
  setTheme(newTheme);
  return newTheme;
}

/**
 * Initialize theme from localStorage or system preference.
 */
export function initTheme(): void {
  // Check localStorage first
  const savedTheme = localStorage.getItem(THEME_KEY) as Theme | null;
  if (savedTheme) {
    setTheme(savedTheme);
    return;
  }

  // Check system preference
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  } else {
    setTheme('light');
  }

  // Listen for system theme changes
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    // Only auto-switch if user hasn't explicitly set a theme
    if (!localStorage.getItem(THEME_KEY)) {
      setTheme(e.matches ? 'dark' : 'light');
    }
  });
}

/**
 * Get theme-aware colors for charts.
 * @returns Chart color configuration
 */
export function getChartColors(): {
  background: string;
  text: string;
  grid: string;
  primary: string;
  secondary: string;
  positive: string;
  negative: string;
} {
  const dark = isDarkMode();
  return {
    background: dark ? '#1a1a2e' : '#ffffff',
    text: dark ? '#e0e0e0' : '#333333',
    grid: dark ? '#333355' : '#e0e0e0',
    primary: '#4a90d9',
    secondary: '#7c3aed',
    positive: '#22c55e',
    negative: '#ef4444',
  };
}

/**
 * Subscribe to theme changes.
 * @param callback - Function to call when theme changes
 * @returns Unsubscribe function
 */
export function onThemeChange(callback: (theme: Theme) => void): () => void {
  const handler = (e: Event): void => {
    const customEvent = e as CustomEvent<{ theme: Theme }>;
    callback(customEvent.detail.theme);
  };

  window.addEventListener('themechange', handler);
  return () => window.removeEventListener('themechange', handler);
}
