/**
 * Tests for formatting utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatPrice,
  formatShares,
  formatPercent,
  formatNumber,
  formatCompactNumber,
  formatDate,
  calculatePercentChange,
} from '@/utils/format';

describe('formatCurrency', () => {
  it('formats positive values correctly', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56');
  });

  it('formats negative values correctly', () => {
    expect(formatCurrency(-1234.56)).toBe('-$1,234.56');
  });

  it('formats zero correctly', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('returns dash for null', () => {
    expect(formatCurrency(null)).toBe('-');
  });

  it('returns dash for undefined', () => {
    expect(formatCurrency(undefined)).toBe('-');
  });

  it('handles large numbers', () => {
    expect(formatCurrency(1234567.89)).toBe('$1,234,567.89');
  });
});

describe('formatPrice', () => {
  it('formats regular tickers with 2 decimals', () => {
    expect(formatPrice(123.456)).toBe('$123.46');
  });

  it('formats SGOV with 3 decimals', () => {
    expect(formatPrice(100.123, 'SGOV')).toBe('$100.123');
  });

  it('is case insensitive for ticker', () => {
    expect(formatPrice(100.123, 'sgov')).toBe('$100.123');
  });

  it('returns dash for null', () => {
    expect(formatPrice(null)).toBe('-');
  });
});

describe('formatShares', () => {
  it('formats whole numbers without trailing zeros', () => {
    expect(formatShares(100)).toBe('100');
  });

  it('preserves up to 4 decimal places', () => {
    expect(formatShares(100.1234)).toBe('100.1234');
  });

  it('trims trailing zeros', () => {
    expect(formatShares(100.1)).toBe('100.1');
  });

  it('returns dash for null', () => {
    expect(formatShares(null)).toBe('-');
  });
});

describe('formatPercent', () => {
  it('formats positive percentages with plus sign', () => {
    expect(formatPercent(12.34)).toBe('+12.34%');
  });

  it('formats negative percentages without extra sign', () => {
    expect(formatPercent(-12.34)).toBe('-12.34%');
  });

  it('formats zero without sign', () => {
    expect(formatPercent(0)).toBe('+0.00%');
  });

  it('returns dash for null', () => {
    expect(formatPercent(null)).toBe('-');
  });
});

describe('formatNumber', () => {
  it('formats with default 2 decimal places', () => {
    expect(formatNumber(123.456)).toBe('123.46');
  });

  it('formats with custom decimal places', () => {
    expect(formatNumber(123.456, 1)).toBe('123.5');
  });

  it('returns dash for null', () => {
    expect(formatNumber(null)).toBe('-');
  });
});

describe('formatCompactNumber', () => {
  it('formats billions', () => {
    expect(formatCompactNumber(1_500_000_000)).toBe('$1.5B');
  });

  it('formats millions', () => {
    expect(formatCompactNumber(1_500_000)).toBe('$1.5M');
  });

  it('formats thousands', () => {
    expect(formatCompactNumber(1_500)).toBe('$1.5K');
  });

  it('formats small numbers as currency', () => {
    expect(formatCompactNumber(500)).toBe('$500.00');
  });

  it('returns dash for null', () => {
    expect(formatCompactNumber(null)).toBe('-');
  });
});

describe('formatDate', () => {
  it('formats ISO date strings', () => {
    const result = formatDate('2024-01-15');
    // Check that it contains expected parts (exact day may vary by timezone)
    expect(result).toContain('Jan');
    expect(result).toContain('2024');
    // Should be either 14 or 15 depending on timezone
    expect(result).toMatch(/1[45]/);
  });

  it('shows a date-only value on its own day, in any time zone', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
        process.env.TZ = zone;
        expect(formatDate('2026-07-01')).toBe('Jul 1, 2026');
        expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
        expect(formatDate('2026-12-31', { month: 'short', day: 'numeric' })).toBe('Dec 31');
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('keeps full timestamps as instants', () => {
    expect(formatDate('2026-07-01T12:00:00Z', { timeZone: 'UTC', day: 'numeric' })).toBe('1');
  });

  it('returns dash for null', () => {
    expect(formatDate(null)).toBe('-');
  });

  it('returns dash for undefined', () => {
    expect(formatDate(undefined)).toBe('-');
  });
});

describe('calculatePercentChange', () => {
  it('calculates positive change', () => {
    expect(calculatePercentChange(110, 100)).toBe(10);
  });

  it('calculates negative change', () => {
    expect(calculatePercentChange(90, 100)).toBe(-10);
  });

  it('returns null when previous is 0', () => {
    expect(calculatePercentChange(100, 0)).toBe(null);
  });

  it('returns null when previous is null', () => {
    expect(calculatePercentChange(100, null)).toBe(null);
  });

  it('returns null when current is null', () => {
    expect(calculatePercentChange(null, 100)).toBe(null);
  });
});
