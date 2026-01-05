/**
 * Local API layer - mirrors server endpoints using client-side SQLite
 *
 * This allows the app to work entirely offline with a local database.
 * Methods return data in formats compatible with the local database schema,
 * which may differ slightly from server API responses (e.g., numeric IDs vs UUIDs).
 */

import type { ClientDatabase } from './client-database';

// Database row types
interface AccountRow {
  id: number;
  name: string;
  account_type: string;
  brokerage: string | null;
  beneficiary: string | null;
  custom_type_name: string | null;
  is_retirement: number;
}

interface PositionRow {
  id: number;
  account_id: number;
  account_name?: string;
  account_type?: string;
  ticker: string;
  name: string | null;
  shares: number;
  cost_basis: number | null;
  current_price: number | null;
  sector: string | null;
  is_fund: number;
  asset_class: string | null;
  position_type: string | null;
}

interface SettingRow {
  key: string;
  value: string;
}

interface PriceCacheRow {
  current_price: number;
  last_updated: string;
}

// API response types
export interface PortfolioSummary {
  total_value: number;
  total_cost_basis: number;
  total_gain_loss: number;
  total_gain_loss_percent: number;
  account_count: number;
  position_count: number;
}

export interface AccountData {
  id: number;
  name: string;
  account_type: string;
  brokerage: string | null;
  beneficiary: string | null;
  custom_type_name: string | null;
  is_retirement: boolean;
}

export interface PositionData {
  id: number;
  account_id: number;
  account_name: string;
  account_type: string;
  ticker: string;
  name: string | null;
  shares: number;
  cost_basis: number | null;
  current_price: number | null;
  value: number;
  gain_loss: number;
  sector: string | null;
  is_fund: boolean;
  asset_class: string | null;
  position_type: string;
}

export interface AllocationData {
  total_value: number;
  by_sector: Record<string, { value: number; percent: number }>;
  by_account_type: Record<string, { value: number; percent: number }>;
  by_asset_class: Record<string, { value: number; percent: number }>;
}

export interface AccountBalancesByType {
  taxable: number;
  traditional: number;
  roth: number;
  total: number;
  by_account: Array<{
    name: string;
    type: string;
    tax_category: string;
    value: number;
  }>;
}

// Input types
export interface CreateAccountInput {
  name: string;
  account_type: string;
  brokerage?: string | null;
  beneficiary?: string | null;
  custom_type_name?: string | null;
  is_retirement?: boolean;
}

export interface CreatePositionInput {
  account_id: number;
  ticker: string;
  name?: string | null;
  shares?: number;
  cost_basis?: number;
  current_price?: number;
  sector?: string | null;
  is_fund?: boolean;
  asset_class?: string | null;
  position_type?: string;
}

export interface UpdatePositionInput {
  shares?: number;
  cost_basis?: number;
  current_price?: number;
  name?: string;
  sector?: string;
}

/**
 * Local API layer using client-side SQLite.
 */
export class LocalAPI {
  constructor(private db: ClientDatabase) {}

  // =====================
  // Portfolio Endpoints
  // =====================

  /**
   * GET /api/portfolio - Get portfolio summary
   */
  getPortfolio(): PortfolioSummary {
    const accounts = this.db.query<AccountRow>('SELECT * FROM accounts');
    const positions = this.db.query<PositionRow>('SELECT * FROM positions');

    let totalValue = 0;
    let totalCost = 0;

    positions.forEach((pos) => {
      const value = (pos.shares || 0) * (pos.current_price || 0);
      totalValue += value;
      totalCost += pos.cost_basis || 0;
    });

    const gainLoss = totalValue - totalCost;
    const gainLossPercent = totalCost > 0 ? (gainLoss / totalCost) * 100 : 0;

    return {
      total_value: totalValue,
      total_cost_basis: totalCost,
      total_gain_loss: gainLoss,
      total_gain_loss_percent: gainLossPercent,
      account_count: accounts.length,
      position_count: positions.length,
    };
  }

  /**
   * GET /api/portfolio/accounts - List all accounts
   */
  getAccounts(): AccountData[] {
    const accounts = this.db.query<AccountRow>('SELECT * FROM accounts ORDER BY name');
    return accounts.map((acc) => ({
      id: acc.id,
      name: acc.name,
      account_type: acc.account_type,
      brokerage: acc.brokerage,
      beneficiary: acc.beneficiary,
      custom_type_name: acc.custom_type_name,
      is_retirement: !!acc.is_retirement,
    }));
  }

  /**
   * POST /api/portfolio/accounts - Create account
   */
  createAccount(data: CreateAccountInput): AccountData & { id: number } {
    const result = this.db.execute(
      `INSERT INTO accounts (name, account_type, brokerage, beneficiary, custom_type_name, is_retirement)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.account_type,
        data.brokerage ?? null,
        data.beneficiary ?? null,
        data.custom_type_name ?? null,
        data.is_retirement ? 1 : 0,
      ]
    );

    if (result.lastId === undefined) {
      throw new Error('Failed to get inserted account ID');
    }

    return {
      id: result.lastId,
      name: data.name,
      account_type: data.account_type,
      brokerage: data.brokerage ?? null,
      beneficiary: data.beneficiary ?? null,
      custom_type_name: data.custom_type_name ?? null,
      is_retirement: data.is_retirement ?? false,
    };
  }

  /**
   * DELETE /api/portfolio/accounts/{id} - Delete account
   */
  deleteAccount(accountId: number): { deleted: boolean } {
    // Delete positions first
    this.db.execute('DELETE FROM positions WHERE account_id = ?', [accountId]);
    // Delete account
    this.db.execute('DELETE FROM accounts WHERE id = ?', [accountId]);
    return { deleted: true };
  }

  /**
   * GET /api/portfolio/positions - List all positions
   */
  getPositions(accountId?: number | null): PositionData[] {
    let sql = `
      SELECT p.*, a.name as account_name, a.account_type
      FROM positions p
      JOIN accounts a ON p.account_id = a.id
    `;
    const params: unknown[] = [];

    if (accountId) {
      sql += ' WHERE p.account_id = ?';
      params.push(accountId);
    }

    sql += ' ORDER BY a.name, p.ticker';

    const positions = this.db.query<PositionRow>(sql, params);
    return positions.map((pos) => ({
      id: pos.id,
      account_id: pos.account_id,
      account_name: pos.account_name ?? '',
      account_type: pos.account_type ?? '',
      ticker: pos.ticker,
      name: pos.name,
      shares: pos.shares,
      cost_basis: pos.cost_basis,
      current_price: pos.current_price,
      value: (pos.shares || 0) * (pos.current_price || 0),
      gain_loss: (pos.shares || 0) * (pos.current_price || 0) - (pos.cost_basis || 0),
      sector: pos.sector,
      is_fund: !!pos.is_fund,
      asset_class: pos.asset_class,
      position_type: pos.position_type || 'equity',
    }));
  }

  /**
   * POST /api/portfolio/positions - Add position
   */
  createPosition(data: CreatePositionInput): PositionData & { id: number } {
    const result = this.db.execute(
      `INSERT INTO positions (account_id, ticker, name, shares, cost_basis, current_price, sector, is_fund, asset_class, position_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.account_id,
        data.ticker,
        data.name ?? null,
        data.shares ?? 0,
        data.cost_basis ?? 0,
        data.current_price ?? 0,
        data.sector ?? null,
        data.is_fund ? 1 : 0,
        data.asset_class ?? null,
        data.position_type ?? 'equity',
      ]
    );

    if (result.lastId === undefined) {
      throw new Error('Failed to get inserted position ID');
    }

    return {
      id: result.lastId,
      account_id: data.account_id,
      account_name: '',
      account_type: '',
      ticker: data.ticker,
      name: data.name ?? null,
      shares: data.shares ?? 0,
      cost_basis: data.cost_basis ?? 0,
      current_price: data.current_price ?? 0,
      value: (data.shares ?? 0) * (data.current_price ?? 0),
      gain_loss: (data.shares ?? 0) * (data.current_price ?? 0) - (data.cost_basis ?? 0),
      sector: data.sector ?? null,
      is_fund: data.is_fund ?? false,
      asset_class: data.asset_class ?? null,
      position_type: data.position_type ?? 'equity',
    };
  }

  /**
   * PUT /api/portfolio/positions/{id} - Update position
   * Note: Column names are hardcoded in the switch below to prevent SQL injection.
   * Only the properties defined in UpdatePositionInput are supported.
   */
  updatePosition(positionId: number, data: UpdatePositionInput): { updated: boolean; id?: number } {
    const updates: string[] = [];
    const params: unknown[] = [];

    if (data.shares !== undefined) {
      updates.push('shares = ?');
      params.push(data.shares);
    }
    if (data.cost_basis !== undefined) {
      updates.push('cost_basis = ?');
      params.push(data.cost_basis);
    }
    if (data.current_price !== undefined) {
      updates.push('current_price = ?');
      params.push(data.current_price);
    }
    if (data.name !== undefined) {
      updates.push('name = ?');
      params.push(data.name);
    }
    if (data.sector !== undefined) {
      updates.push('sector = ?');
      params.push(data.sector);
    }

    if (updates.length === 0) {
      return { updated: false };
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(positionId);

    this.db.execute(`UPDATE positions SET ${updates.join(', ')} WHERE id = ?`, params);

    return { updated: true, id: positionId };
  }

  /**
   * DELETE /api/portfolio/positions/{id} - Delete position
   */
  deletePosition(positionId: number): { deleted: boolean } {
    this.db.execute('DELETE FROM positions WHERE id = ?', [positionId]);
    return { deleted: true };
  }

  // =====================
  // Analysis Endpoints
  // =====================

  /**
   * GET /api/analysis/allocation - Get allocation breakdown
   */
  getAllocation(): AllocationData {
    const positions = this.getPositions();

    const bySector: Record<string, number> = {};
    const byAccountType: Record<string, number> = {};
    const byAssetClass: Record<string, number> = {};
    let totalValue = 0;

    positions.forEach((pos) => {
      const value = pos.value || 0;
      totalValue += value;

      // By sector
      const sector = pos.sector || 'Unknown';
      bySector[sector] = (bySector[sector] || 0) + value;

      // By account type
      const accType = pos.account_type || 'Unknown';
      byAccountType[accType] = (byAccountType[accType] || 0) + value;

      // By asset class
      const assetClass = pos.asset_class || 'Equity';
      byAssetClass[assetClass] = (byAssetClass[assetClass] || 0) + value;
    });

    // Convert to percentages
    const toPercent = (obj: Record<string, number>): Record<string, { value: number; percent: number }> => {
      const result: Record<string, { value: number; percent: number }> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = {
          value: value,
          percent: totalValue > 0 ? (value / totalValue) * 100 : 0,
        };
      }
      return result;
    };

    return {
      total_value: totalValue,
      by_sector: toPercent(bySector),
      by_account_type: toPercent(byAccountType),
      by_asset_class: toPercent(byAssetClass),
    };
  }

  /**
   * GET /api/projections/account-balances-by-type
   */
  getAccountBalancesByType(): AccountBalancesByType {
    const positions = this.getPositions();
    const accounts = this.getAccounts();

    const accountMap = new Map<number, AccountData>();
    accounts.forEach((acc) => {
      accountMap.set(acc.id, acc);
    });

    const TAX_CATEGORY_MAP: Record<string, string> = {
      taxable: 'taxable',
      brokerage: 'taxable',
      checking: 'taxable',
      savings: 'taxable',
      hysa: 'taxable',
      '529': 'taxable',
      treasury_direct: 'taxable',
      traditional_401k: 'traditional',
      traditional_ira: 'traditional',
      '401k': 'traditional',
      ira: 'traditional',
      pension: 'traditional',
      hsa: 'traditional',
      roth_401k: 'roth',
      roth_ira: 'roth',
      roth: 'roth',
    };

    const totals = { taxable: 0, traditional: 0, roth: 0 };
    const accountTotals = new Map<number, { name: string; type: string; tax_category: string; value: number }>();

    positions.forEach((pos) => {
      const value = pos.value || 0;
      const account = accountMap.get(pos.account_id);
      if (!account) return;

      const accType = account.account_type.toLowerCase().replace(/[ -]/g, '_');
      let taxCategory = TAX_CATEGORY_MAP[accType] || 'taxable';

      if (account.is_retirement && taxCategory === 'taxable') {
        taxCategory = 'traditional';
      }

      totals[taxCategory as keyof typeof totals] += value;

      if (!accountTotals.has(pos.account_id)) {
        accountTotals.set(pos.account_id, {
          name: account.name,
          type: account.account_type,
          tax_category: taxCategory,
          value: 0,
        });
      }
      const entry = accountTotals.get(pos.account_id)!;
      entry.value += value;
    });

    return {
      taxable: totals.taxable,
      traditional: totals.traditional,
      roth: totals.roth,
      total: totals.taxable + totals.traditional + totals.roth,
      by_account: Array.from(accountTotals.values()),
    };
  }

  // =====================
  // Settings Endpoints
  // =====================

  /**
   * GET /api/settings/config - Get config
   * Values stored as JSON are parsed; non-JSON values are returned as strings.
   */
  getConfig(): Record<string, unknown> {
    const settings = this.db.query<SettingRow>('SELECT * FROM app_settings');
    const config: Record<string, unknown> = {};
    settings.forEach((s) => {
      try {
        config[s.key] = JSON.parse(s.value);
      } catch (e) {
        // Value is not valid JSON - use as string
        // This can happen for legacy string values or simple primitives
        console.debug(`Config key '${s.key}' is not JSON, using as string:`, e);
        config[s.key] = s.value;
      }
    });
    return config;
  }

  /**
   * PUT /api/settings/config - Update config
   */
  updateConfig(key: string, value: unknown): { updated: boolean } {
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.db.execute(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`, [key, valueStr]);
    return { updated: true };
  }

  // =====================
  // Price Cache
  // =====================

  /**
   * Get cached price for ticker
   */
  getCachedPrice(ticker: string): PriceCacheRow | null {
    const result = this.db.query<PriceCacheRow>(
      'SELECT current_price, last_updated FROM price_cache WHERE ticker = ?',
      [ticker]
    );
    return result[0] ?? null;
  }

  /**
   * Update price cache
   */
  updatePriceCache(ticker: string, price: number): void {
    this.db.execute(
      `INSERT OR REPLACE INTO price_cache (ticker, current_price, last_updated)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [ticker, price]
    );
  }

  /**
   * Update position prices from cache
   */
  applyPriceUpdates(priceMap: Record<string, number>): { updated: number } {
    for (const [ticker, price] of Object.entries(priceMap)) {
      this.db.execute(
        'UPDATE positions SET current_price = ?, updated_at = CURRENT_TIMESTAMP WHERE ticker = ?',
        [price, ticker]
      );
      this.updatePriceCache(ticker, price);
    }
    return { updated: Object.keys(priceMap).length };
  }
}

// Export a factory function
export function createLocalAPI(clientDatabase: ClientDatabase): LocalAPI {
  return new LocalAPI(clientDatabase);
}
