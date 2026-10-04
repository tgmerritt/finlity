/**
 * Single source of "today" for liabilities code, so tests can pin it
 * (vi.setSystemTime). Local calendar day, matching src/liabilities/clock.py.
 */
export function today(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear()).padStart(4, '0')}-${mm}-${dd}`;
}
