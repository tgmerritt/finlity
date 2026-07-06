/**
 * Regression tests for F10: CD maturity date handling.
 *
 * - checkCDMaturities()/getUpcomingCDMaturities() must compare calendar
 *   dates (not epoch ms via `new Date("YYYY-MM-DD").getTime()`), which
 *   parses as UTC midnight and can appear "already past" a full day early
 *   from the perspective of a negative-UTC-offset timezone on the same
 *   calendar day.
 * - getUpcomingCDMaturities() must have the future-only lower bound v1 has
 *   (`maturity_date > today`) — a CD that already matured must not show up
 *   in "upcoming" maturities.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { ClientDatabase } from '@/database/client-database';
import type { LocalAPI } from '@/database/local-api';
import { createTestApi, useSequentialUuids } from './helpers';

/** Format a Date as local "YYYY-MM-DD" (matches LocalAPI's private todayDateString). */
function toDateString(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysFromToday(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toDateString(d);
}

describe('LocalAPI CD maturity date handling (F10)', () => {
  let restore: () => void;
  let db: ClientDatabase;
  let api: LocalAPI;

  afterEach(() => {
    restore?.();
  });

  async function setup(): Promise<void> {
    restore = useSequentialUuids();
    const created = await createTestApi();
    db = created.db;
    api = created.api;
  }

  it('checkCDMaturities converts a CD maturing today (calendar date), regardless of time-of-day parsing quirks', async () => {
    await setup();
    const account = api.createAccount({ name: 'Bank', account_type: 'savings' });
    api.createCDPosition({
      account_id: account.id,
      name: '1yr CD',
      amount: 1000,
      interest_rate: 0.04,
      maturity_date: daysFromToday(0),
    });

    const result = api.checkCDMaturities();
    expect(result.matured_count).toBe(1);
    expect(result.converted[0]?.final_value).toBeGreaterThanOrEqual(1000);

    const positions = api.getPositions();
    expect(positions[0]?.position_type).toBe('cash');
    expect(positions[0]?.ticker).toBe('CASH');
  });

  it('checkCDMaturities converts a CD that matured in the past', async () => {
    await setup();
    const account = api.createAccount({ name: 'Bank', account_type: 'savings' });
    api.createCDPosition({
      account_id: account.id,
      name: 'Old CD',
      amount: 500,
      interest_rate: 0.03,
      maturity_date: daysFromToday(-5),
    });

    const result = api.checkCDMaturities();
    expect(result.matured_count).toBe(1);
  });

  it('checkCDMaturities does NOT convert a CD maturing tomorrow', async () => {
    await setup();
    const account = api.createAccount({ name: 'Bank', account_type: 'savings' });
    api.createCDPosition({
      account_id: account.id,
      name: 'Future CD',
      amount: 500,
      interest_rate: 0.03,
      maturity_date: daysFromToday(1),
    });

    const result = api.checkCDMaturities();
    expect(result.matured_count).toBe(0);
    expect(api.getPositions()[0]?.position_type).toBe('cd');
  });

  it('getUpcomingCDMaturities excludes a CD that already matured today (future-only lower bound)', async () => {
    await setup();
    const account = api.createAccount({ name: 'Bank', account_type: 'savings' });
    api.createCDPosition({
      account_id: account.id,
      name: 'Matured today',
      amount: 500,
      interest_rate: 0.03,
      maturity_date: daysFromToday(0),
    });

    const upcoming = api.getUpcomingCDMaturities(30);
    expect(upcoming).toHaveLength(0);
  });

  it('getUpcomingCDMaturities excludes a CD that matured in the past', async () => {
    await setup();
    const account = api.createAccount({ name: 'Bank', account_type: 'savings' });
    api.createCDPosition({
      account_id: account.id,
      name: 'Old CD',
      amount: 500,
      interest_rate: 0.03,
      maturity_date: daysFromToday(-10),
    });

    const upcoming = api.getUpcomingCDMaturities(30);
    expect(upcoming).toHaveLength(0);
  });

  it('getUpcomingCDMaturities includes a CD maturing within the window with the correct days_until_maturity', async () => {
    await setup();
    const account = api.createAccount({ name: 'Bank', account_type: 'savings' });
    api.createCDPosition({
      account_id: account.id,
      name: 'Soon CD',
      amount: 500,
      interest_rate: 0.03,
      maturity_date: daysFromToday(10),
    });

    const upcoming = api.getUpcomingCDMaturities(30);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.days_until_maturity).toBe(10);
  });

  it('getUpcomingCDMaturities excludes a CD maturing beyond the requested window', async () => {
    await setup();
    const account = api.createAccount({ name: 'Bank', account_type: 'savings' });
    api.createCDPosition({
      account_id: account.id,
      name: 'Far CD',
      amount: 500,
      interest_rate: 0.03,
      maturity_date: daysFromToday(60),
    });

    const upcoming = api.getUpcomingCDMaturities(30);
    expect(upcoming).toHaveLength(0);
  });
});
