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
    await expect(seedDemoDatasetIfEmpty()).resolves.toBeUndefined();
    expect(mockSave).not.toHaveBeenCalled();
  });
});
