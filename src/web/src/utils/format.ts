/**
 * Formatting utilities for currency, numbers, and percentages.
 */

/**
 * Format a number as US currency.
 * @param value - The number to format
 * @returns Formatted currency string or '-' if null/undefined
 */
export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format a price with appropriate decimal places.
 * SGOV and certain securities use 3 decimal places.
 * @param value - The price to format
 * @param ticker - Optional ticker symbol for special formatting
 * @returns Formatted price string or '-' if null/undefined
 */
export function formatPrice(value: number | null | undefined, ticker?: string | null): string {
  if (value === null || value === undefined) return '-';
  const decimals = ticker && ticker.toUpperCase() === 'SGOV' ? 3 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format shares/quantity with up to 4 decimal places, trimming trailing zeros.
 * @param value - The number of shares
 * @returns Formatted shares string or '-' if null/undefined
 */
export function formatShares(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const formatted = value.toFixed(4);
  return parseFloat(formatted).toString();
}

/**
 * Format a number as a percentage with sign.
 * @param value - The percentage value (already multiplied by 100)
 * @returns Formatted percentage string or '-' if null/undefined
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Format a number with fixed decimal places.
 * @param value - The number to format
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted number string or '-' if null/undefined
 */
export function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined) return '-';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format a large number with K/M/B suffixes.
 * @param value - The number to format
 * @returns Formatted string with suffix
 */
export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }
  return formatCurrency(value);
}

/**
 * Format a date string to a localized display format.
 * @param dateString - ISO date string
 * @param options - Intl.DateTimeFormat options
 * @returns Formatted date string
 */
export function formatDate(
  dateString: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }
): string {
  if (!dateString) return '-';
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', options);
  } catch {
    return dateString;
  }
}

/**
 * Format a date for chart axis labels.
 * @param dateString - ISO date string
 * @returns Short formatted date string
 */
export function formatChartDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return dateString;
  }
}

/**
 * Calculate percentage change between two values.
 * @param current - Current value
 * @param previous - Previous value
 * @returns Percentage change or null if previous is 0
 */
export function calculatePercentChange(
  current: number | null | undefined,
  previous: number | null | undefined
): number | null {
  if (current === null || current === undefined) return null;
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}
