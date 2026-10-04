/**
 * seedDemoDatasetIfEmpty (src/features/onboarding.ts) — hosted-mode demo
 * seeding: a fresh visitor's empty browser DB gets populated from the
 * server's read-only demo export so the showcase lands on real numbers
 * instead of $0. Guards: locked-demo-only, never touch a non-empty DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApiCall, mockQuery, mockExecute, mockSave } = vi.hoisted(() => ({
  mockApiCall: vi.fn(),
  mockQuery: vi.fn(),
  mockExecute: vi.fn(),
  mockSave: vi.fn(),
}));

vi.mock('@/api/client', () => ({ apiCall: mockApiCall }));
vi.mock('@/database/client-database', () => ({
  clientDB: {
    query: mockQuery,
    execute: mockExecute,
    saveToIndexedDB: mockSave,
  },
}));
vi.mock('@/ui/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/ui/loading', () => ({ showLoading: vi.fn(), hideLoading: vi.fn() }));
vi.mock('@/ui/tabs', () => ({ showTab: vi.fn() }));

import { seedDemoDatasetIfEmpty } from '@/features/onboarding';

const LOCKED = { enabled: true, disable_locked: true };
const UNLOCKED = { enabled: true, disable_locked: false };

const EXPORT = {
  entities: [
    { id: 'john-demo', name: 'John', entity_type: 'individual', color: '#aaa', icon: 'user' },
    { id: 'jane-demo', name: 'Jane', entity_type: 'individual', color: '#bbb', icon: 'user' },
  ],
  accounts: [
    { id: 'acc1', entity_id: 'john-demo', name: 'Company 401k', account_type: 'traditional_401k', brokerage: 'Fidelity', is_retirement_account: 1 },
  ],
  positions: [
    { id: 'pos1', account_id: 'acc1', ticker: 'VOO', name: 'Vanguard S&P 500 ETF', shares: 10, current_price: 500, cost_basis: 4000, is_fund: 1, asset_class: 'equity', position_type: 'fund' },
  ],
  snapshots: [
    { id: 's1', snapshot_date: '2026-01-06', total_value: 5000, retirement_value: 5000, taxable_value: 0, positions_json: '[]', created_at: '2026-01-06' },
  ],
  liabilities: [
    {
      id: 'demo-mortgage', entity_id: 'household-demo', name: 'Mortgage', liability_type: 'mortgage',
      lender: 'Bank', current_balance: 491903.01, balance_as_of: '2026-09-30', interest_rate: 0.0625,
      payment_amount: 3201.73, payment_frequency: 'monthly', next_payment_date: '2022-08-01',
      escrow_amount: null, original_principal: 520000, origination_date: '2022-07-01', term_months: 360,
      maturity_date: null, credit_limit: null, is_amortizing: 1, linked_position_id: 'demo-home',
      expense_id: 'server-expense-id', source: 'demo', source_ref: null, source_detail: null,
      is_active: 1, closed_date: null, notes: null,
    },
    {
      id: 'demo-card', entity_id: 'john-demo', name: 'Credit card', liability_type: 'credit_card',
      lender: 'Chase', current_balance: 2755, balance_as_of: '2026-09-30', is_amortizing: 0,
      linked_position_id: null, expense_id: null, credit_limit: 15000, is_active: 1,
    },
  ],
  liability_snapshots: [
    { id: 'ls1', liability_id: 'demo-mortgage', snapshot_date: '2026-08-31', balance: 495000, source: 'demo', source_ref: null },
  ],
};

describe('seedDemoDatasetIfEmpty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSave.mockResolvedValue(undefined);
  });

  it('seeds a fresh DB when the server reports locked demo mode', async () => {
    mockApiCall.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/export') ? EXPORT : LOCKED)
    );
    mockQuery.mockReturnValue([{ n: 0 }]);

    await seedDemoDatasetIfEmpty();

    const executedTables = mockExecute.mock.calls.map((c) => c[0]).join('\n');
    expect(executedTables).toContain('INSERT OR IGNORE INTO accounts');
    expect(executedTables).toContain('INSERT OR IGNORE INTO positions');
    expect(executedTables).toContain('INSERT OR IGNORE INTO portfolio_snapshots');
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO entities'), ['john-demo', 'John', 'individual', '#aaa', 'user']);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('does nothing when demo mode is unlocked (personal/self-hosted server)', async () => {
    mockApiCall.mockResolvedValue(UNLOCKED);
    await seedDemoDatasetIfEmpty();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('never touches a DB that already has accounts (real portfolio protection)', async () => {
    mockApiCall.mockResolvedValue(LOCKED);
    mockQuery.mockReturnValue([{ n: 3 }]);
    await seedDemoDatasetIfEmpty();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('degrades to a warning (no throw, no partial persist) when the export fails', async () => {
    mockApiCall.mockImplementation((url: string) =>
      url.endsWith('/export') ? Promise.reject(new Error('boom')) : Promise.resolve(LOCKED)
    );
    mockQuery.mockReturnValue([{ n: 0 }]);
    await expect(seedDemoDatasetIfEmpty()).resolves.toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  describe('liabilities', () => {
    function seed() {
      mockApiCall.mockImplementation((url: string) =>
        Promise.resolve(url.endsWith('/export') ? EXPORT : LOCKED)
      );
      mockQuery.mockReturnValue([{ n: 0 }]);
    }
    const sqls = () => mockExecute.mock.calls.map((c) => c[0] as string);
    const callFor = (needle: string, id: string) =>
      mockExecute.mock.calls.find((c) => (c[0] as string).includes(needle) && (c[1] as unknown[])[0] === id);

    it('inserts liabilities and snapshots with INSERT OR IGNORE', async () => {
      seed();
      await seedDemoDatasetIfEmpty();
      expect(sqls().some((q) => q.includes('INSERT OR IGNORE INTO liabilities'))).toBe(true);
      expect(sqls().some((q) => q.includes('INSERT OR IGNORE INTO liability_balance_snapshots'))).toBe(true);
      expect(callFor('INTO liability_balance_snapshots', 'ls1')?.[1]).toEqual(
        ['ls1', 'demo-mortgage', '2026-08-31', 495000, 'demo', null]
      );
    });

    it('nulls expense_id, keeps linked_position_id and passes 10-char dates', async () => {
      seed();
      await seedDemoDatasetIfEmpty();
      const call = callFor('INTO liabilities', 'demo-mortgage');
      const sql = call?.[0] as string;
      const params = call?.[1] as unknown[];
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
      const at = (c: string) => params[cols.indexOf(c)];
      expect(at('expense_id')).toBeNull();
      expect(at('linked_position_id')).toBe('demo-home');
      expect(at('balance_as_of')).toBe('2026-09-30');
      expect(at('next_payment_date')).toBe('2022-08-01');
      expect(at('maturity_date')).toBeNull();
      // household entity is not exported; the dangling id becomes null
      expect(at('entity_id')).toBeNull();
      const card = callFor('INTO liabilities', 'demo-card')?.[1] as unknown[];
      expect(card[cols.indexOf('entity_id')]).toBe('john-demo');
      expect(card[cols.indexOf('payment_frequency')]).toBe('monthly');
    });

    it('slices datetime-shaped dates to YYYY-MM-DD', async () => {
      const data = structuredClone(EXPORT);
      data.liabilities[1].balance_as_of = '2026-09-30T00:00:00';
      data.liability_snapshots[0].snapshot_date = '2026-08-31 00:00:00';
      mockApiCall.mockImplementation((url: string) =>
        Promise.resolve(url.endsWith('/export') ? data : LOCKED)
      );
      mockQuery.mockReturnValue([{ n: 0 }]);
      await seedDemoDatasetIfEmpty();
      const card = callFor('INTO liabilities', 'demo-card');
      const sql = card?.[0] as string;
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
      expect((card?.[1] as unknown[])[cols.indexOf('balance_as_of')]).toBe('2026-09-30');
      expect((callFor('INTO liability_balance_snapshots', 'ls1')?.[1] as unknown[])[2]).toBe('2026-08-31');
    });

    it('still works against an older export without liabilities', async () => {
      const old = { ...EXPORT, liabilities: undefined, liability_snapshots: undefined };
      mockApiCall.mockImplementation((url: string) =>
        Promise.resolve(url.endsWith('/export') ? old : LOCKED)
      );
      mockQuery.mockReturnValue([{ n: 0 }]);
      await expect(seedDemoDatasetIfEmpty()).resolves.toBe(true);
      expect(sqls().some((q) => q.includes('liabilit'))).toBe(false);
    });

    it('rolls back and persists nothing when a liability insert throws', async () => {
      seed();
      mockExecute.mockImplementation((sql: string) => {
        if (sql.includes('INTO liabilities')) throw new Error('constraint failed');
        return { changes: 1 };
      });
      await expect(seedDemoDatasetIfEmpty()).resolves.toBe(false);
      const q = sqls();
      expect(q[0]).toBe('BEGIN');
      expect(q).toContain('ROLLBACK');
      expect(q).not.toContain('COMMIT');
      expect(mockSave).not.toHaveBeenCalled();
      mockExecute.mockReset();
    });

    it('commits before saving on success', async () => {
      seed();
      await seedDemoDatasetIfEmpty();
      const q = sqls();
      expect(q[0]).toBe('BEGIN');
      expect(q[q.length - 1]).toBe('COMMIT');
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it('slices the other four date columns and nulls invalid optional ones', async () => {
      const data = structuredClone(EXPORT);
      Object.assign(data.liabilities[0], {
        next_payment_date: '2022-08-01T00:00:00',
        origination_date: '2022-07-01 00:00:00',
        maturity_date: '2052-07-01T12:00:00',
        closed_date: 'garbage',
      });
      mockApiCall.mockImplementation((url: string) =>
        Promise.resolve(url.endsWith('/export') ? data : LOCKED)
      );
      mockQuery.mockReturnValue([{ n: 0 }]);
      await seedDemoDatasetIfEmpty();
      const call = callFor('INTO liabilities', 'demo-mortgage');
      const sql = call?.[0] as string;
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
      const at = (c: string) => (call?.[1] as unknown[])[cols.indexOf(c)];
      expect(at('next_payment_date')).toBe('2022-08-01');
      expect(at('origination_date')).toBe('2022-07-01');
      expect(at('maturity_date')).toBe('2052-07-01');
      expect(at('closed_date')).toBeNull();
    });

    it('skips rows whose required date is invalid', async () => {
      const data = structuredClone(EXPORT);
      data.liabilities[1].balance_as_of = 'bad';
      data.liability_snapshots[0].snapshot_date = '';
      mockApiCall.mockImplementation((url: string) =>
        Promise.resolve(url.endsWith('/export') ? data : LOCKED)
      );
      mockQuery.mockReturnValue([{ n: 0 }]);
      await seedDemoDatasetIfEmpty();
      expect(callFor('INTO liabilities', 'demo-card')).toBeUndefined();
      expect(callFor('INTO liabilities', 'demo-mortgage')).toBeDefined();
      expect(callFor('INTO liability_balance_snapshots', 'ls1')).toBeUndefined();
    });

    it('keeps a null entity_id null', async () => {
      const data = structuredClone(EXPORT);
      (data.liabilities[1] as Record<string, unknown>).entity_id = null;
      mockApiCall.mockImplementation((url: string) =>
        Promise.resolve(url.endsWith('/export') ? data : LOCKED)
      );
      mockQuery.mockReturnValue([{ n: 0 }]);
      await seedDemoDatasetIfEmpty();
      const call = callFor('INTO liabilities', 'demo-card');
      const sql = call?.[0] as string;
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
      expect((call?.[1] as unknown[])[cols.indexOf('entity_id')]).toBeNull();
    });

    it('skips entirely when accounts exist', async () => {
      mockApiCall.mockResolvedValue(LOCKED);
      mockQuery.mockReturnValue([{ n: 1 }]);
      await seedDemoDatasetIfEmpty();
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });
});
