/**
 * Tests for LocalAPI allocation_triggers CRUD and portfolio_views CRUD.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { LocalAPI } from '@/database/local-api';
import { createTestApi, useSequentialUuids } from './helpers';

describe('LocalAPI triggers', () => {
  let restore: () => void;
  let api: LocalAPI;

  afterEach(() => {
    restore?.();
  });

  async function setup(): Promise<void> {
    restore = useSequentialUuids();
    const created = await createTestApi();
    api = created.api;
  }

  it('creates a trigger active by default and lists it', async () => {
    await setup();
    const trigger = api.createTrigger({
      name: 'AAPL too big',
      condition_type: 'ticker_percent',
      operator: '>',
      threshold: 10,
      ticker: 'AAPL',
    });
    expect(trigger.is_active).toBe(true);
    expect(api.getTriggers()).toHaveLength(1);
  });

  it('toggleTrigger flips is_active', async () => {
    await setup();
    const trigger = api.createTrigger({ name: 'Test', condition_type: 'ticker_percent', operator: '>', threshold: 5 });
    const toggled = api.toggleTrigger(trigger.id);
    expect(toggled.is_active).toBe(false);
    expect(api.getTriggers(true)).toHaveLength(0);
  });

  it('deleteTrigger removes it', async () => {
    await setup();
    const trigger = api.createTrigger({ name: 'Test', condition_type: 'sector_percent', operator: '<', threshold: 5 });
    api.deleteTrigger(trigger.id);
    expect(api.getTriggers()).toHaveLength(0);
  });
});

describe('LocalAPI portfolio views', () => {
  let restore: () => void;
  let api: LocalAPI;

  afterEach(() => {
    restore?.();
  });

  async function setup(): Promise<void> {
    restore = useSequentialUuids();
    const created = await createTestApi();
    api = created.api;
  }

  it('seeds a default "All Accounts" view on a fresh database', async () => {
    await setup();
    const views = api.getViews();
    expect(views.some((v) => v.name === 'All Accounts' && v.is_default)).toBe(true);
  });

  it('creates a view with account_ids serialized/deserialized as a string array', async () => {
    await setup();
    const view = api.createView({ name: 'Retirement Only', account_ids: ['acc-1', 'acc-2'] });
    expect(view.account_ids).toEqual(['acc-1', 'acc-2']);

    const fetched = api.getViews().find((v) => v.id === view.id);
    expect(fetched?.account_ids).toEqual(['acc-1', 'acc-2']);
  });

  it('setDefaultView clears the previous default', async () => {
    await setup();
    const view = api.createView({ name: 'Custom View', account_ids: [] });
    api.setDefaultView(view.id);

    const views = api.getViews();
    const defaults = views.filter((v) => v.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(view.id);
  });

  it('cannot delete the All Accounts view', async () => {
    await setup();
    const allAccounts = api.getViews().find((v) => v.name === 'All Accounts')!;
    expect(() => api.deleteView(allAccounts.id)).toThrow();
  });

  it('deletes a non-protected view', async () => {
    await setup();
    const view = api.createView({ name: 'Temp View', account_ids: [] });
    api.deleteView(view.id);
    expect(api.getViews().find((v) => v.id === view.id)).toBeUndefined();
  });
});
