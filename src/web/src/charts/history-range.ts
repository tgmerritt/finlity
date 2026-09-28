/**
 * Pure helpers for the portfolio value history chart.
 *
 * Kept free of Plotly and the DOM so they can be unit tested under jsdom.
 */
import type { SnapshotHistory } from '@/types/api';

export const MIN_HISTORY_POINTS = 2;

export const HISTORY_EMPTY_MESSAGE = 'Your history builds as Finlity records a daily snapshot.';

/** Snapshots dated within the last `days` days of `now`. */
export function filterHistoryForRange(
  history: SnapshotHistory[],
  days: number,
  now: Date = new Date()
): SnapshotHistory[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  return history.filter((h) => new Date(h.date) >= cutoff);
}

/** True when the history spans at least MIN_HISTORY_POINTS distinct calendar days. */
export function hasPlottableHistory(history: SnapshotHistory[]): boolean {
  const days = new Set(history.map((h) => String(h.date).slice(0, 10)));
  return days.size >= MIN_HISTORY_POINTS;
}

/** X axis settings that keep ticks at day resolution. */
export function historyDateAxis(): {
  type: 'date';
  tickformat: string;
  hoverformat: string;
  nticks: number;
} {
  return { type: 'date', tickformat: '%b %d', hoverformat: '%b %d, %Y', nticks: 6 };
}
