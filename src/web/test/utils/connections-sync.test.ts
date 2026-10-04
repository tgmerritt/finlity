/**
 * Pure Sync now helpers (plan C3, design 9.2): what is worth reviewing, the
 * turns of 12, the wizard's prefill and the mapping write-back after Apply.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  accountErrorLines,
  mappingFor,
  noNewText,
  previewRequest,
  reviewable,
  splitTurns,
  withMappedKinds,
  stoppedText,
  withSomethingNew,
  writeBackRequest,
} from '@/utils/connections-sync';
import type { WizardStatement } from '@/utils/smart-import-state';
import type { ConnectionAccount, ConnectionDetail, NormalizedStatement } from '@/types/api';

function account(over: Partial<ConnectionAccount> = {}): ConnectionAccount {
  return {
    provider_account_id: 'demo-card',
    name: 'Demo Rewards Card',
    institution: 'Demo Bank',
    currency: 'USD',
    kind: 'credit_card',
    role: 'debt',
    label: 'Rewards',
    account_key: 'acct:card',
    liability_id: 'debt-1',
    flip_balance: false,
    same_as_key: null,
    next_since: '2026-07-01',
    ...over,
  };
}

const detail = {
  id: 'conn-1',
  accounts: [
    account(),
    account({
      provider_account_id: 'demo-chk',
      kind: 'checking',
      role: 'cash_flow',
      label: 'Everyday',
      account_key: 'acct:chk',
      liability_id: null,
    }),
    account({
      provider_account_id: 'demo-sav',
      kind: 'savings',
      role: 'ignore',
      account_key: 'acct:sav',
      liability_id: null,
    }),
  ],
} as Pick<ConnectionDetail, 'id' | 'accounts'>;

function stmt(key: string, over: Partial<NormalizedStatement> = {}): NormalizedStatement {
  return {
    file_hash: `${key}-hash`,
    file_name: 'Demo bank sync 2026-10-04',
    origin: 'connector',
    format: 'connector',
    parser: 'connector:demo',
    account: { kind: 'checking', key, last4: null, institution: 'Demo Bank' },
    period: { start: '2026-09-01', end: '2026-10-04' },
    closing_balance: { amount: 10, as_of: '2026-10-04' },
    extras: null,
    warnings: [],
    transactions: [
      {
        row: 0,
        posted_date: '2026-10-01',
        amount: -5,
        description: 'SHOP',
        merchant_key: 'SHOP',
        kind: 'expense',
        category_id: null,
        category_source: 'none',
        external_id: 'demo:x:0',
        dedupe_base: `${key}-b0`,
      },
    ],
    ...over,
  };
}

function wiz(over: Partial<WizardStatement> = {}): WizardStatement {
  return {
    id: 'c1:0',
    file_id: 'c1',
    file_hash: 'h',
    file_name: 'Demo bank sync',
    origin: 'connector',
    connection_id: 'conn-1',
    format: 'connector',
    parser: 'connector:demo',
    account_kind: 'credit_card',
    account_key: 'acct:card',
    account_label: 'Rewards',
    last4: null,
    institution: null,
    period: { start: null, end: null },
    closing_balance: null,
    extras: null,
    warnings: [],
    liability_id: 'debt-1',
    suggested_liability_id: null,
    skipped: false,
    prior_import_at: null,
    ...over,
  };
}

describe('reviewable', () => {
  it('keeps rows, and a balance only when the account is linked to a debt', () => {
    const out = reviewable(
      [
        stmt('acct:chk'),
        stmt('acct:chk', { file_hash: 'b', transactions: [] }),
        stmt('acct:card', { file_hash: 'c', transactions: [] }),
        stmt('acct:card', { file_hash: 'd', transactions: [], closing_balance: null }),
      ],
      detail
    );
    expect(out.map((s) => s.file_hash)).toEqual(['acct:chk-hash', 'c']);
  });
});

describe('withSomethingNew', () => {
  it('drops windows applied before and all-duplicate statements without a debt balance', () => {
    const statements = [
      stmt('acct:chk'),
      stmt('acct:card'),
      stmt('acct:chk', { file_hash: 'applied-before' }),
    ];
    const out = withSomethingNew(statements, detail, {
      existing_dedupe_keys: ['acct:chk|acct:chk-b0', 'acct:card|acct:card-b0'],
      prior_files: [{ file_hash: 'applied-before', import_id: 'i', imported_at: null }],
    });
    // The card keeps its balance for the linked debt; the checking rows are all stored.
    expect(out.map((s) => s.file_hash)).toEqual(['acct:card-hash']);
  });

  it('asks the preview with the same keys Apply stores', () => {
    expect(previewRequest([stmt('acct:chk')]).statements[0]).toMatchObject({
      account_key: 'acct:chk',
      dedupe_keys: ['acct:chk|acct:chk-b0'],
      merchant_keys: ['SHOP'],
    });
  });
});

describe('a balance on a debt-role account without a stored link', () => {
  const unlinked = {
    id: 'conn-1',
    accounts: [account({ role: 'debt', liability_id: null })],
  } as Pick<ConnectionDetail, 'id' | 'accounts'>;
  const balanceOnly = stmt('acct:card', { transactions: [] });

  it('is kept by reviewable, so the wizard can link it', () => {
    expect(reviewable([balanceOnly], unlinked)).toHaveLength(1);
  });

  it('is kept by withSomethingNew when every row is stored', () => {
    const out = withSomethingNew([stmt('acct:card')], unlinked, {
      existing_dedupe_keys: ['acct:card|acct:card-b0'],
      prior_files: [],
    });
    expect(out).toHaveLength(1);
  });

  it('is still dropped for a cash-flow account', () => {
    const cash = {
      id: 'conn-1',
      accounts: [account({ role: 'cash_flow', kind: 'checking', liability_id: null })],
    } as Pick<ConnectionDetail, 'id' | 'accounts'>;
    expect(reviewable([balanceOnly], cash)).toHaveLength(0);
  });
});

describe('withMappedKinds', () => {
  it('sets each statement account kind from the connection as it is now', () => {
    const now = {
      accounts: [account({ kind: 'checking', role: 'cash_flow', liability_id: null })],
    } as Pick<ConnectionDetail, 'accounts'>;
    const card = stmt('acct:card', {
      account: { kind: 'credit_card', key: 'acct:card', last4: null, institution: null },
    });
    const other = stmt('acct:other');
    const out = withMappedKinds([card, other], now);
    expect(out[0]!.account.kind).toBe('checking');
    expect(out[1]).toBe(other);
    expect(card.account.kind).toBe('credit_card');
  });
});

describe('splitTurns', () => {
  it('cuts into turns of 12 and keeps the order', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(splitTurns(items).map((t) => t.length)).toEqual([12, 12, 1]);
    expect(splitTurns(items)[1]![0]).toBe(12);
    expect(splitTurns([])).toEqual([]);
  });
});

describe('mappingFor', () => {
  it('maps each synced account key (same as wins) and leaves ignored accounts out', () => {
    const map = mappingFor({
      accounts: [
        ...detail.accounts,
        account({ provider_account_id: 'x', account_key: 'acct:x', same_as_key: 'acct:file' }),
      ],
    });
    expect(map['acct:card']).toEqual({ liability_id: 'debt-1', label: 'Rewards', role: 'debt' });
    expect(map['acct:file']).toBeDefined();
    expect(map['acct:x']).toBeUndefined();
    expect(map['acct:sav']).toBeUndefined();
  });
});

describe('writeBackRequest', () => {
  it('is null when nothing changed', () => {
    expect(writeBackRequest(detail, [wiz()])).toBeNull();
  });

  it('sends a changed debt link and kind, newest statement winning', () => {
    const out = writeBackRequest(detail, [
      wiz({ liability_id: 'debt-2' }),
      wiz({ id: 'c2:0', liability_id: 'debt-3' }),
      wiz({ id: 'c3:0', account_key: 'acct:chk', account_kind: 'savings', liability_id: null }),
    ]);
    expect(out).toEqual({
      accounts: {
        'demo-card': { liability_id: 'debt-3' },
        'demo-chk': { kind: 'savings' },
      },
    });
  });

  it('makes an account a debt when a debt is linked to it', () => {
    const out = writeBackRequest(detail, [
      wiz({ account_key: 'acct:chk', account_kind: 'credit_card', liability_id: 'debt-9' }),
    ]);
    expect(out).toEqual({
      accounts: { 'demo-chk': { kind: 'credit_card', liability_id: 'debt-9', role: 'debt' } },
    });
  });

  it('ignores skipped statements, windows applied before and other connections', () => {
    expect(
      writeBackRequest(detail, [
        wiz({ liability_id: null, skipped: true }),
        wiz({ liability_id: null, prior_import_at: '2026-10-01' }),
        wiz({ liability_id: null, connection_id: 'other' }),
        wiz({ liability_id: null, origin: 'file', connection_id: null }),
      ])
    ).toBeNull();
  });

  it('drops the link when the kind is no longer a debt kind', () => {
    expect(
      writeBackRequest(detail, [wiz({ account_kind: 'checking', liability_id: 'debt-1' })])
    ).toEqual({ accounts: { 'demo-card': { kind: 'checking', liability_id: null } } });
  });
});

describe('copy', () => {
  it('names the date and the parts', () => {
    expect(noNewText('2026-07-06')).toBe('No new transactions since Jul 6, 2026.');
    expect(stoppedText(1, 3, 'The provider did not answer in time.')).toContain(
      'The sync stopped after part 1 of 3.'
    );
  });

  it('names the account a provider flagged', () => {
    expect(
      accountErrorLines(
        [
          { provider_account_id: 'demo-chk', code: 'connector_account_error' },
          { provider_account_id: 'demo-chk', code: 'connector_account_error' },
          { provider_account_id: null, code: 'x' },
        ],
        detail,
        (c) => `text for ${c}`
      )
    ).toEqual(['Everyday: text for connector_account_error', 'text for x']);
  });

  it('has no em-dash in the module', () => {
    const src = readFileSync(resolve(__dirname, '../../src/utils/connections-sync.ts'), 'utf8');
    expect(src).not.toContain(String.fromCharCode(0x2014));
  });
});
