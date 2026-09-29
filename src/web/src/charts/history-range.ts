/**
 * Pure helpers for the portfolio value history chart.
 *
 * Kept free of Plotly and the DOM so they can be unit tested under jsdom.
 */
import type { SnapshotHistory } from '@/types/api';

export const MIN_HISTORY_POINTS = 2;

export const HISTORY_EMPTY_MESSAGE = 'Your history builds as Finlity records a daily snapshot.';

/** Extract YYYY-MM-DD calendar date from a date string (handles both date-only and datetime formats). */
function calendarDay(date: string): string {
  return String(date).slice(0, 10);
}

/** Snapshots dated within the last `days` days of `now`. */
export function filterHistoryForRange(
  history: SnapshotHistory[],
  days: number,
  now: Date = new Date()
): SnapshotHistory[] {
  // Compute cutoff calendar day by subtracting `days` from `now`'s UTC date
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffYear = cutoff.getUTCFullYear();
  const cutoffMonth = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
  const cutoffDate = String(cutoff.getUTCDate()).padStart(2, '0');
  const cutoffDayStr = `${cutoffYear}-${cutoffMonth}-${cutoffDate}`;

  return history.filter((h) => calendarDay(h.date) >= cutoffDayStr);
}

/** True when the history spans at least MIN_HISTORY_POINTS distinct calendar days. */
export function hasPlottableHistory(history: SnapshotHistory[]): boolean {
  const days = new Set(history.map((h) => calendarDay(h.date)));
  return days.size >= MIN_HISTORY_POINTS;
}

/** Maximum distinct calendar days for which we show one tick per day. */
const MAX_DAYS_FOR_PER_DAY_TICKS = 6;

interface HistoryDateAxisWithTickvals {
  type: 'date';
  tickformat: string;
  hoverformat: string;
  tickvals: string[];
}

interface HistoryDateAxisWithNticks {
  type: 'date';
  tickformat: string;
  hoverformat: string;
  nticks: number;
}

/**
 * X axis settings that keep ticks at day resolution.
 *
 * When the filtered history spans a handful of distinct calendar days,
 * Plotly's automatic date ticking can place more than one tick within the
 * same day (e.g. every 12 hours), which repeats the same formatted label.
 * In that case we pin one tick per distinct day instead. Longer ranges fall
 * back to Plotly's automatic `nticks` spacing.
 */
export function historyDateAxis(
  history: SnapshotHistory[]
): HistoryDateAxisWithTickvals | HistoryDateAxisWithNticks {
  const days = Array.from(new Set(history.map((h) => calendarDay(h.date)))).sort();

  if (days.length <= MAX_DAYS_FOR_PER_DAY_TICKS) {
    return {
      type: 'date',
      tickformat: '%b %d',
      hoverformat: '%b %d, %Y',
      tickvals: days,
    };
  }

  return { type: 'date', tickformat: '%b %d', hoverformat: '%b %d, %Y', nticks: 6 };
}
