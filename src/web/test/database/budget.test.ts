/**
 * Tests for LocalAPI budget methods: income sources, pretax deductions,
 * expenses (with embedded category name + computed annual/monthly amounts).
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { LocalAPI } from '@/database/local-api';
import { createTestApi, useSequentialUuids } from './helpers';

describe('LocalAPI budget', () => {
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

  it('creates an income source and computes gross_per_period from pay_frequency', async () => {
    await setup();
    api.createIncomeSource({ name: 'Primary Job', gross_annual: 130000, pay_frequency: 'biweekly' });
    const sources = api.getIncomeSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.gross_per_period).toBeCloseTo(130000 / 26, 5);
  });

  it('getIncomeSources only returns active sources', async () => {
    await setup();
    const income = api.createIncomeSource({ name: 'Old Job', gross_annual: 50000 });
    api.updateIncomeSource(income.id, { is_active: false });
    expect(api.getIncomeSources()).toHaveLength(0);
  });

  it('creates a pretax deduction and computes annual_amount/employer_annual from linked income pay_frequency', async () => {
    await setup();
    const income = api.createIncomeSource({ name: 'Job', gross_annual: 100000, pay_frequency: 'monthly' });
    api.createDeduction({ income_source_id: income.id, amount_per_period: 500, employer_match: 100, deduction_type: '401k' });

    const deductions = api.getDeductions();
    expect(deductions).toHaveLength(1);
    expect(deductions[0]?.income_source_name).toBe('Job');
    expect(deductions[0]?.periods_per_year).toBe(12);
    expect(deductions[0]?.annual_amount).toBe(6000);
    expect(deductions[0]?.employer_annual).toBe(1200);
  });

  it('deduction with no linked income source defaults to biweekly (26 periods)', async () => {
    await setup();
    api.createDeduction({ amount_per_period: 100, label: 'Standalone HSA', deduction_type: 'hsa' });
    const deductions = api.getDeductions();
    expect(deductions[0]?.periods_per_year).toBe(26);
    expect(deductions[0]?.annual_amount).toBe(2600);
  });

  it('creates an expense embedding category_name and computing annual/monthly amounts', async () => {
    await setup();
    const categories = api.getExpenseCategories();
    const housing = categories.find((c) => c.name === 'Housing');
    expect(housing).toBeDefined();

    api.createExpense({ category_id: housing!.id, name: 'Rent', amount: 2000, frequency: 'monthly' });
    const expenses = api.getExpenses();
    expect(expenses).toHaveLength(1);
    expect(expenses[0]?.category_name).toBe('Housing');
    expect(expenses[0]?.annual_amount).toBe(24000);
    expect(expenses[0]?.monthly_amount).toBe(2000);
  });

  it('one_time expenses do not get annualized', async () => {
    await setup();
    const categories = api.getExpenseCategories();
    const other = categories.find((c) => c.name === 'Other')!;
    api.createExpense({ category_id: other.id, name: 'Vet bill', amount: 300, frequency: 'one_time' });
    const expenses = api.getExpenses();
    expect(expenses[0]?.annual_amount).toBe(300);
  });

  it('expense-categories are seeded with all 12 defaults in sort_order', async () => {
    await setup();
    const categories = api.getExpenseCategories();
    expect(categories).toHaveLength(12);
    expect(categories[0]?.name).toBe('Housing');
    expect(categories[categories.length - 1]?.name).toBe('Other');
  });

  it('getStates returns the full 51-entry US state list including DC', async () => {
    await setup();
    const states = api.getStates();
    expect(states).toHaveLength(51);
    expect(states.find((s) => s.code === 'CA')).toEqual({ code: 'CA', name: 'California', type: 'graduated' });
    expect(states.find((s) => s.code === 'DC')).toBeDefined();
    expect(states.find((s) => s.code === 'TX')?.type).toBe('none');
  });

  it('getTaxConfig returns server defaults when none exists', async () => {
    await setup();
    const config = api.getTaxConfig();
    expect(config.tax_year).toBe(2024);
    expect(config.filing_status).toBe('single');
    expect(config.use_standard_deduction).toBe(true);
    expect(config.ss_claiming_age).toBe(67);
  });

  it('updateTaxConfig creates then updates a single household row', async () => {
    await setup();
    api.updateTaxConfig({ filing_status: 'married_joint', itemized_deduction: 25000 });
    let config = api.getTaxConfig();
    expect(config.filing_status).toBe('married_joint');
    expect(config.use_standard_deduction).toBe(false);

    api.updateTaxConfig({ tax_year: 2025 });
    config = api.getTaxConfig();
    expect(config.tax_year).toBe(2025);
    expect(config.filing_status).toBe('married_joint'); // preserved
  });
});
