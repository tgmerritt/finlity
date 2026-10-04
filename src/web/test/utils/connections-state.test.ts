/**
 * Pure helpers for the Connect dialog and account mapping: credential bodies,
 * the mode-dependent disclosure, error copy and the mapping's PUT body.
 */

import { describe, it, expect } from 'vitest';
import {
  accountCodeText,
  accountsErrorText,
  buildUpdateRequest,
  connectErrorText,
  createBody,
  credentialBody,
  credentialFields,
  disclosureLines,
  editsFrom,
  fittingDebts,
  initialState,
  isMappingDirty,
  labelError,
  mappingErrors,
  PROVIDER_LINE,
  sameAsChoices,
  setEdit,
} from '@/utils/connections-state';
import { WARNING_COPY } from '@/utils/smart-import-render';
import type { ConnectionAccount, LiabilityResponse, SmartImportContext } from '@/types/api';

const EM_DASH = String.fromCharCode(0x2014);

function acct(over: Partial<ConnectionAccount> = {}): ConnectionAccount {
  return {
    provider_account_id: 'demo-card',
    name: 'Demo Rewards Card',
    institution: 'Demo bank',
    currency: 'USD',
    kind: 'credit_card',
    role: 'debt',
    label: 'Demo Rewards Card',
    account_key: 'acct:card',
    liability_id: null,
    flip_balance: false,
    same_as_key: null,
    next_since: '2026-07-08',
    ...over,
  };
}

function debt(over: Partial<LiabilityResponse>): LiabilityResponse {
  return {
    id: 'l1',
    entity_id: null,
    name: 'Visa',
    liability_type: 'credit_card',
    lender: 'Bank',
    current_balance: 100,
    balance_as_of: '2026-10-01',
    interest_rate: null,
    payment_amount: null,
    payment_frequency: 'monthly',
    next_payment_date: null,
    escrow_amount: null,
    original_principal: null,
    origination_date: null,
    term_months: null,
    maturity_date: null,
    credit_limit: null,
    is_amortizing: false,
    linked_position_id: null,
    expense_id: null,
    source: 'manual',
    source_ref: null,
    is_active: true,
    closed_date: null,
    notes: null,
    ...over,
  } as LiabilityResponse;
}

describe('provider copy', () => {
  it('states the SimpleFIN price and the Akahu personal app', () => {
    expect(PROVIDER_LINE.simplefin).toContain('$1.50 a month or $15 a year, paid to SimpleFIN');
    expect(PROVIDER_LINE.akahu).toContain('personal app at my.akahu.nz');
    expect(PROVIDER_LINE.demo).toContain('synthetic data');
    for (const line of Object.values(PROVIDER_LINE)) expect(line).not.toContain(EM_DASH);
  });
});

describe('credentials', () => {
  it('asks SimpleFIN for one field, Akahu for two and the demo for none', () => {
    expect(credentialFields('simplefin').map((f) => f.name)).toEqual(['secret']);
    expect(credentialFields('akahu').map((f) => f.name)).toEqual(['user_token', 'app_token']);
    expect(credentialFields('demo')).toEqual([]);
  });

  it('sends https:// input as an Access URL and anything else as a setup token', () => {
    expect(credentialBody('simplefin', { secret: '  aGVsbG8=  ' })).toEqual({
      setup_token: 'aGVsbG8=',
    });
    expect(
      credentialBody('simplefin', { secret: 'https://u:p@bridge.simplefin.org/simplefin' })
    ).toEqual({ access_url: 'https://u:p@bridge.simplefin.org/simplefin' });
    expect(credentialBody('simplefin', { secret: '   ' })).toBeNull();
  });

  it('needs both Akahu tokens', () => {
    expect(credentialBody('akahu', { user_token: 'u', app_token: '' })).toBeNull();
    expect(credentialBody('akahu', { user_token: ' u ', app_token: 'a' })).toEqual({
      user_token: 'u',
      app_token: 'a',
    });
  });

  it('builds the create body with the range and an optional label', () => {
    expect(createBody('demo', '', 60, {})).toEqual({ provider: 'demo', first_sync_days: 60 });
    expect(createBody('simplefin', ' Mine ', 90, { secret: 'tok' })).toEqual({
      provider: 'simplefin',
      first_sync_days: 90,
      label: 'Mine',
      setup_token: 'tok',
    });
    expect(createBody('akahu', '', 30, {})).toBeNull();
  });

  it('checks the label length', () => {
    expect(labelError('x'.repeat(120))).toBeNull();
    expect(labelError('x'.repeat(121))).toContain('120');
  });

  it('keeps no credential in the dialog state', () => {
    const keys = Object.keys(initialState());
    for (const k of keys) expect(k).not.toMatch(/token|secret|url|credential/i);
  });
});

describe('disclosure', () => {
  it('says server mode encrypts it in this server’s database', () => {
    const text = disclosureLines('simplefin', 'server').join(' ');
    expect(text).toMatch(/^Your token is encrypted and stored in this server’s database/);
    expect(text).not.toContain('sealed in this browser');
    expect(text).toContain('disable this app in your SimpleFIN Bridge account');
  });

  it('says hosted mode seals it in this browser and the server does not store or log it', () => {
    const text = disclosureLines('akahu', 'local').join(' ');
    expect(text).toContain('sealed in this browser');
    expect(text).toMatch(/^Your tokens are sealed in this browser/);
    expect(text).toContain('passes them through Finlity’s server');
    expect(text).toContain('does not store them or log them');
    expect(text).toContain('not against a script running inside this page');
    expect(text).not.toContain('this server’s database');
    expect(text).toContain('delete the personal app at my.akahu.nz');
  });

  it('differs by mode and never uses an em-dash', () => {
    expect(disclosureLines('simplefin', 'server')).not.toEqual(
      disclosureLines('simplefin', 'local')
    );
    for (const p of ['simplefin', 'akahu', 'demo'] as const) {
      for (const m of ['server', 'local'] as const) {
        expect(disclosureLines(p, m).join(' ')).not.toContain(EM_DASH);
      }
    }
  });
});

describe('errors', () => {
  const err = (type: string, detail = 'secret-echo') => ({
    status: 422,
    data: { error_type: type, detail },
  });

  it('gives compromised-token advice for claim_refused', () => {
    const text = connectErrorText(err('claim_refused'))!;
    expect(text).toContain('compromised');
    expect(text).toContain('disable it at SimpleFIN Bridge');
  });

  it.each(['claim_not_saved', 'claim_timeout'])('asks for a new setup token for %s', (code) => {
    expect(connectErrorText(err(code))).toContain('Create a new setup token');
  });

  it('never echoes the server detail, and falls back to null for unknown codes', () => {
    for (const code of ['host_not_allowed', 'connection_limit', 'bad_setup_token']) {
      expect(connectErrorText(err(code))).not.toContain('secret-echo');
    }
    expect(connectErrorText(err('weird'))).toBeNull();
    expect(connectErrorText(new Error('https://u:p@host'))).toBeNull();
    expect(accountsErrorText('provider_timeout')).toContain('did not answer');
    expect(accountsErrorText('weird')).toBe('The account list could not be loaded.');
  });
});

describe('mapping', () => {
  const detail = {
    accounts: [
      acct(),
      acct({
        provider_account_id: 'demo-chk',
        kind: 'checking',
        role: 'cash_flow',
        label: 'Everyday',
        account_key: 'acct:chk',
      }),
    ],
  };

  it('starts from the stored mapping and sends nothing when unchanged', () => {
    const edits = editsFrom(detail);
    expect(edits['demo-card']).toEqual({
      kind: 'credit_card',
      role: 'debt',
      label: 'Demo Rewards Card',
      liability_id: null,
      same_as_key: null,
    });
    expect(buildUpdateRequest(detail, edits)).toBeNull();
    expect(isMappingDirty(detail, edits)).toBe(false);
  });

  it('sends only the changed fields per account', () => {
    let edits = editsFrom(detail);
    edits = setEdit(edits, 'demo-card', { liability_id: 'l1' });
    edits = setEdit(edits, 'demo-chk', { label: ' Bills ', same_as_key: 'acct:file' });
    expect(buildUpdateRequest(detail, edits)).toEqual({
      accounts: {
        'demo-card': { liability_id: 'l1' },
        'demo-chk': { label: 'Bills', same_as_key: 'acct:file' },
      },
    });
  });

  it('drops the debt link when the role is no longer debt', () => {
    const linked = { accounts: [acct({ liability_id: 'l1' })] };
    const edits = setEdit(editsFrom(linked), 'demo-card', { role: 'ignore' });
    expect(buildUpdateRequest(linked, edits)).toEqual({
      accounts: { 'demo-card': { role: 'ignore', liability_id: null } },
    });
  });

  it('blocks an empty label', () => {
    const edits = setEdit(editsFrom(detail), 'demo-chk', { label: '  ' });
    expect(mappingErrors(edits)).toEqual({ 'demo-chk': 'Enter a name for this account.' });
  });

  it('offers fitting active debts, plus the chosen one', () => {
    const list = [
      debt({ id: 'card' }),
      debt({ id: 'car', liability_type: 'auto_loan' as LiabilityResponse['liability_type'] }),
      debt({ id: 'old', is_active: false }),
    ];
    expect(fittingDebts(list, 'credit_card', null).map((l) => l.id)).toEqual(['card']);
    expect(fittingDebts(list, 'loan', null).map((l) => l.id)).toEqual(['car']);
    expect(fittingDebts(list, 'credit_card', 'car').map((l) => l.id)).toEqual(['card', 'car']);
  });

  it('offers known accounts as "Same as", never the account itself', () => {
    const known: SmartImportContext['accounts'] = [
      {
        account_key: 'acct:card',
        label: 'Self',
        last4: null,
        kind: 'credit_card',
        institution: null,
        liability_id: null,
      },
      {
        account_key: 'acct:file',
        label: 'Visa',
        last4: '1234',
        kind: 'credit_card',
        institution: null,
        liability_id: null,
      },
      {
        account_key: 'acct:file2',
        label: null,
        last4: null,
        kind: 'checking',
        institution: 'Bank',
        liability_id: null,
      },
    ];
    const choices = sameAsChoices(known, acct());
    expect(choices).toEqual([
      { value: '', label: 'Keep separate' },
      { value: 'acct:file', label: 'Visa (ending 1234)' },
      { value: 'acct:file2', label: 'Bank' },
    ]);
    const kept = sameAsChoices([], acct({ same_as_key: 'acct:gone' }));
    expect(kept.map((c) => c.value)).toEqual(['', 'acct:gone']);
  });
});

describe('one text for connector_account_error', () => {
  it('is the wizard warning text in the account list too', () => {
    expect(accountCodeText('connector_account_error')).toBe(WARNING_COPY.connector_account_error);
  });
});
