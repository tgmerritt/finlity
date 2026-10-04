# Liabilities: debts, net worth and a guided add flow

Status: proposed, 2026-10-04. Second of four projects (dashboard, **liabilities**, smart import, connections). Builds on `docs/design/2026-09-28-dashboard-redesign.md`, which reserved a net-worth slot in the hero "rendered only when liabilities exist (project 2)".

## Goal

Finlity answers "how much do I have?" with assets only. People also owe money, and the honest answer is net worth. This project adds:

1. Liabilities as first-class records (mortgage, auto loan, student loan, credit card, personal loan, HELOC, other), with balance history and an amortization model.
2. Net worth on the dashboard, next to (not instead of) portfolio value.
3. Debt payments in cash flow, and debt paydown in Projections, kept minimal.
4. A guided wizard to add a debt in under a minute, on a phone, with sensible defaults.
5. An explicit, user-confirmed path to turn an existing "RE" position (how people record a home or mortgage today, before this feature) into a proper mortgage and property.

Statement upload, AI categorization (project 3) and account connections (project 4) are out of scope. The data model carries a `source` / `source_ref` / `source_detail` provenance triple so those projects can create and update liabilities later without schema changes.

## What exists today (findings)

- **Positions and accounts.** `accounts` and `positions` (`src/database/models.py`). Real estate is a position with `ticker='RE'`, `shares=1`, `position_type='real_estate'`, `asset_class='alternative'`, value in `current_price`, created by `POST /api/portfolio/positions/real-estate` (`src/api/portfolio.py`, LocalAPI `createRealEstatePosition`). The endpoint's docstring already says "For net equity, subtract your mortgage balance". An account type `property` exists in `src/models/account_types.py` (not retirement).
- **Dashboard.** `GET /api/dashboard/data` is composed in `src/main.py` (server) and in the `dispatcher.ts` `local('GET', '/api/dashboard/data')` route (hosted). `summary.total_value` is the sum of all positions, real estate included. History is `portfolio_snapshots` (`total`, `retirement`, `taxable`). The hero (`renderHero` in `pages/dashboard.ts`) shows "Portfolio value"; the Accounts card groups accounts into Retirement, Taxable and Cash & savings (`groupAccounts` in `utils/portfolio-metrics.ts`); a `property` account currently lands in Taxable. "Needs attention" is `attentionItems()`.
- **Cash flow.** `budget_expenses` already has `is_mortgage`, `principal_portion`, `interest_portion`, `start_date`, `end_date`, and a default "Debt Payments" category exists. Annual cash flow is `compute_annual_summary` (`src/api/budget.py`), fed by stored expenses on the server and by `buildExpensePayloads()` in hosted mode. The demo budget already has "Mortgage" $3,200/mo and "Car Payment #1" $450/mo.
- **Projections.** Monte Carlo takes `current_balance` (defaults to `total_value`, so it includes real estate today) and returns `ages` plus percentile series. Hosted mode rewrites to `/api/v2/projections/monte-carlo`.
- **Schema and migrations.** `Database.__init__` runs `Base.metadata.create_all` (creates missing tables, never alters existing ones) and then `_migrate_schema()` (ad hoc `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE` if missing, and one historical row rewrite for options). `DatabaseManager.check()` reports `SCHEMA_MISMATCH` whenever `PRAGMA user_version != SCHEMA_VERSION` (equality), and `SCHEMA_VERSION = 1`. The browser schema is `ClientDatabase.SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS` for every table) run by `migrateSchema()` on every open; `recordSchemaVersion()` writes `app_settings.schema_version` with `INSERT OR REPLACE` when the constant is higher.
- **Demo data.** The tracked `data/demo/demo.db` is not reproducible by `scripts/generate_demo.py`: that script deletes the file, uses unseeded `random`, fetches live prices and creates no entities, while the tracked file has `household-demo`, `john-demo`, `jane-demo` and entity-assigned accounts. At startup in demo mode `ensure_recent_demo_history` deletes and regenerates `portfolio_snapshots` so history ends yesterday. Hosted visitors are seeded from `GET /api/settings/demo-mode/export` (entities, accounts, positions, snapshots only; no budget).
- **Duplicates.** `find_duplicate_positions` / LocalAPI `getDuplicates` flag the same ticker and exact share count in different accounts, so two `RE` positions (shares 1.0) in two accounts would be flagged.
- **Backup.** `import_database` calls `reset_database()` (`drop_all`) and restores only accounts, positions and triggers. Budget data is already lost on a JSON restore; liabilities will be too. Known limitation, not fixed here.

## Decisions

### 1. Data model (two new tables, nothing else)

All amounts are in dollars as REAL. APR is a decimal (0.0625), matching `positions.interest_rate`; percent appears only at the form boundary. Dates are stored like the rest of the schema (SQLAlchemy `DateTime` on the server, ISO text in the browser) and compared on their first 10 characters (`YYYY-MM-DD`).

**`liabilities`**

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `entity_id` | TEXT, nullable | owner (entities). Null = household/joint. Soft reference (see below). |
| `name` | TEXT NOT NULL | "Mortgage", "Chase Sapphire" |
| `liability_type` | TEXT NOT NULL | `mortgage`, `auto_loan`, `student_loan`, `credit_card`, `personal_loan`, `heloc`, `other` |
| `lender` | TEXT, nullable | |
| `current_balance` | REAL NOT NULL | latest *reported* balance (denormalized copy of the newest snapshot) |
| `balance_as_of` | DATE NOT NULL | date of that report |
| `interest_rate` | REAL, nullable | APR as decimal, 0 to 1 |
| `payment_amount` | REAL, nullable | scheduled payment per period (principal and interest only; for cards, the amount the user plans to pay) |
| `payment_frequency` | TEXT NOT NULL default `monthly` | `weekly`, `biweekly`, `monthly`, `quarterly`, `annual` (the budget vocabulary minus `one_time`, so expense links are lossless) |
| `next_payment_date` | DATE, nullable | any known due date; due dates are this date plus or minus whole periods |
| `escrow_amount` | REAL, nullable | mortgage only: taxes and insurance per period, counted in cash flow, not in amortization |
| `original_principal` | REAL, nullable | |
| `origination_date` | DATE, nullable | |
| `term_months` | INTEGER, nullable | |
| `maturity_date` | DATE, nullable | stored when given; otherwise derived as origination + term |
| `credit_limit` | REAL, nullable | credit card and HELOC |
| `is_amortizing` | INTEGER NOT NULL | 1 for installment loans; 0 for revolving balances. Defaults by type (decision 2). |
| `linked_position_id` | TEXT, nullable | the asset this debt is secured by (a mortgage's home). Soft reference. |
| `expense_id` | TEXT, nullable | the `budget_expenses` row that carries this debt's payment into cash flow. Soft reference. |
| `source` | TEXT NOT NULL default `manual` | `manual`, `wizard`, `converted_position`, `demo`; reserved for later: `statement_import` (project 3), `connection` (project 4) |
| `source_ref` | TEXT, nullable | external id (statement account number hash, aggregator account id) or, for conversions, the source position id |
| `source_detail` | TEXT, nullable | JSON. Conversions store the original position row and what they created, so a revert is exact. Imports will store parser metadata. |
| `is_active` | INTEGER NOT NULL default 1 | 0 = archived (paid off and hidden) |
| `closed_date` | DATE, nullable | set when archived; history counts 0 from this date |
| `notes` | TEXT, nullable | |
| `created_at`, `updated_at` | DATETIME | |

**`liability_balance_snapshots`**

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `liability_id` | TEXT NOT NULL | references `liabilities(id)` |
| `snapshot_date` | DATE NOT NULL | local calendar day (the process or browser local date, same on both paths) |
| `balance` | REAL NOT NULL | |
| `source` | TEXT NOT NULL default `manual` | same vocabulary as `liabilities.source` |
| `created_at` | DATETIME | |

Unique index on `(liability_id, snapshot_date)`: recording a balance twice on one day replaces that day's row.

Snapshots hold **reported** balances only (what the user typed, what the wizard saved, later what an import read). Balances between reports are computed, not stored (decision 3). This keeps both data paths free of background writers: the hosted path has no daily job, and a computed history cannot drift between the two paths.

**Soft references.** `entity_id`, `linked_position_id` and `expense_id` are not enforced as foreign keys and are resolved on read. If the referenced row no longer exists (a position deleted, an account re-imported with new position ids, an expense deleted, an entity deleted) the API returns the field as `null` plus a flag (`linked_position_missing`, `expense_missing`) and the UI offers to relink. This means no existing delete path (`delete_position`, `delete_account`, `clear_account_positions`, `clear_positions_by_import`, `delete_entity`, `deleteExpense` and their LocalAPI twins) has to change, and nothing cascades into user data. Deleting a liability deletes its own snapshots and nothing else.

**Migration.** The two tables are added as SQLAlchemy models (created by the existing `create_all` on every `Database()` construction) and as two `CREATE TABLE IF NOT EXISTS` blocks plus `CREATE UNIQUE INDEX IF NOT EXISTS` appended to `SCHEMA_SQL`. That is the whole migration. No `ALTER`, `DROP`, `UPDATE` or `DELETE` against any existing table, no new entries in `_migrate_schema`, no startup data writes. **Neither schema version constant changes**: bumping `SCHEMA_VERSION` would make `check()` report `SCHEMA_MISMATCH` for every existing database, and bumping `ClientDatabase.SCHEMA_VERSION` would rewrite the `app_settings.schema_version` row. Both are tested (plan Task A2).

### 2. Liability types and defaults

| Type | `is_amortizing` | Wizard defaults | Linked asset | Cash flow default |
|---|---|---|---|---|
| Mortgage | 1 | APR 6.5%, 30-year term, monthly, escrow optional | home (real estate position): link or create | Housing category, `is_mortgage=1` with principal/interest split |
| Auto loan | 1 | APR 7.0%, 60 months | optional, any position | Transportation |
| Student loan | 1 | APR 5.5%, 120 months | none | Debt Payments |
| Credit card | 0 | APR 24%, "I pay it in full each month" = yes | none | none when paid in full (spending is already in the budget); otherwise Debt Payments with the planned payment |
| Personal loan | 1 | APR 12%, 36 months | none | Debt Payments |
| HELOC | 0 | APR 8.5%, interest-only payment (balance x APR / 12) | home: link | Housing |
| Other | 0 (1 if a term is entered) | none | optional | Debt Payments |

Payment and term are two views of one fact. If the user gives a term and no payment, the payment is the standard annuity payment on the current balance over the remaining term. If the user gives a payment, the term follows from it. The review step shows both.

### 3. Amortization and balances

One pure module per path, `src/liabilities/amortization.py` and `src/web/src/utils/amortization.ts`, checked against the same golden file `tests/fixtures/amortization_cases.json` (pytest from the repo root, vitest via `../../tests/fixtures/` from `src/web`).

- Periods per year: weekly 52, biweekly 26, monthly 12, quarterly 4, annual 1. Periodic rate `r = APR / periods_per_year`.
- Annuity payment for balance `B` over `n` periods: `B*r / (1 - (1+r)^-n)`, or `B/n` when `r = 0`.
- Balance after `k` payments: `B(1+r)^k - p((1+r)^k - 1)/r` (or `B - k*p`), floored at 0.
- Periods to payoff: `ceil(-ln(1 - rB/p) / ln(1+r))` when `p > rB`; `null` ("never pays off at this payment") when `p <= rB`; capped at 600 periods. The schedule's last payment is the remaining balance plus interest.
- Due dates: `next_payment_date` plus or minus whole periods (months for monthly/quarterly/annual with the day clamped to month end; 7 or 14 days otherwise).
- No intermediate rounding. Outputs are rounded to cents at the API boundary; parity tests compare money within 0.01 and counts and dates exactly.

**Balance on a date** (`balance_at(liability, snapshots, date)`), used for "today", history and projections:
1. If `closed_date <= date`: 0. If `origination_date > date`: 0.
2. Anchor = the latest reported snapshot on or before `date`; if none, the earliest snapshot (flat back-fill: honest, and avoids a cliff in the net-worth line on the day a user adds an old debt).
3. Amortizing: roll the anchor forward by the number of due dates in `(anchor_date, date]`. Revolving: the anchor balance.

`GET /api/liabilities` returns, per liability, `estimated_balance` (balance today), `payoff_date`, `periods_remaining`, `total_interest_remaining`, `monthly_payment` (payment x periods per year / 12) and `monthly_cash_flow` (monthly payment plus monthly escrow). The full schedule is computed in the browser from these fields (both modes run the same TS), so there is no schedule endpoint.

### 4. Net worth on the dashboard

`/api/dashboard/data` (both paths) gains, additively:

- `summary.liabilities_included` (bool), `summary.liabilities_total`, `summary.net_worth`, and `summary.liabilities`: one entry per active liability with `id`, `name`, `liability_type`, `balance` (estimated today), `interest_rate`, `payment_amount`, `payment_frequency`, `payoff_date`, `linked_position_id`, `entity_id`, `is_amortizing`, `last_reported_date`.
- Each `history` item gains `liabilities` and `net_worth` (computed per snapshot date with `balance_at`).

`summary.total_value` keeps its meaning (all assets, real estate included), so nothing that reads it today changes. Liabilities are household-wide and not tied to accounts, so they are included only when the response is unfiltered (no `view_id`, or a view whose account list is empty). With a view filter, `liabilities_included` is false and the dashboard looks exactly as it does today.

**Hero.** When liabilities are included and at least one active liability exists:
- Label "Net worth", big number = net worth (can be negative, shown with a minus sign and the negative color).
- New line under it: "Assets $1,284,000 · Debts $412,300" (`#hero-breakdown`).
- Today's change: the assets' day change in dollars (debts do not move intraday); percent against yesterday's net worth when that is positive, otherwise dollars only.
- Range change: computed on the `net_worth` series with the same rule.
- "Total gain" is unchanged (it is investment gain).
- Without liabilities: exactly today's hero ("Portfolio value", no breakdown line).

**History chart.** In net-worth mode the traces are Net worth (primary, 2px), Assets (1px, green) and Debts (1px, red, plotted as a positive amount). Retirement and Taxable are dropped in this mode to keep the phone chart readable; they remain in the Accounts list. Without liabilities the chart is unchanged.

**Accounts card.** Groups in order: Retirement, Taxable, Cash & savings, **Property** (new: accounts of type `property`), **Liabilities** (new). The Liabilities group header shows a negative subtotal ("-$412,300"); each row shows the name, the balance as a negative amount, and a meta line "6.25% · paid off Jul 2052" (or "Card · updated Sep 12"). Selecting a row opens the Debts page on that liability. A final "Net worth" row closes the list. Asset rows keep "percent of total" relative to total assets.

**Allocation vs target.** Positions in accounts of type `property` are excluded: a home is not part of an investment allocation. This is frontend-only and changes nothing for positions in other account types (see open question 6).

**Needs attention.** Three new items, built from the dashboard payload:
- No liabilities, at least one account: "Add your debts to see your net worth" with "Add debts" (opens the wizard) and "I have none" (dismisses; stored in `localStorage` in try/catch).
- A real estate position no liability links to: "Is Home financed?" with "Review" (opens the conversion dialog for that position, decision 8). Dismissible per position id (`localStorage`).
- A revolving liability whose last reported balance is older than 45 days: "Update the Chase Sapphire balance" with "Update" (opens the balance dialog).

The first-run empty state (no accounts) is unchanged.

### 5. Debts page

A new page `debts` titled **Debts**, in the sidebar after Holdings, reachable on phones through More (the bottom bar keeps its five items). The Person filter applies (by `entity_id`, null shown under Household); the View filter is hidden.

- Summary strip: total owed, monthly payments, "Debt-free by Mar 2052".
- One card per liability, grouped by type: name and lender, balance, APR, payment and frequency, payoff date, a progress bar (paid of original principal when known), and actions Update balance, Edit, Delete. Archived debts sit in a collapsed "Paid off" section.
- Detail (opened from a card or from the dashboard): balance history chart (reported points plus the computed line), the amortization schedule summarized by year with a per-month expansion, linked home and linked expense with relink actions, and the "linked item missing" warnings.
- Empty state: "Add your debts to see your net worth" with an "Add a debt" button (the wizard).
- Phones: cards stack, actions are 44px targets, the schedule table becomes a year list.

### 6. Cash flow

Cash flow integration reuses the existing expense pipeline: a liability's payment reaches cash flow through a linked `budget_expenses` row. No budget calculation changes in either path, and hosted mode needs no payload changes because `buildExpensePayloads()` already sends every expense.

- The wizard offers three choices: **create** an expense (amount = monthly payment plus escrow, `frequency='monthly'`, category by type, `end_date` = payoff date, and for mortgages `is_mortgage=1` with `principal_portion` and `interest_portion` from the next period's split), **link** an existing expense (suggested when an expense's name contains the type word or its monthly amount is within 10% of the payment; the demo's "Mortgage" and "Car Payment #1" are found this way), or **none**.
- Editing a liability's payment, escrow or frequency updates its linked expense in the same transaction (the edit form says so and offers to opt out for that save).
- The expense list shows a "Linked to Mortgage" chip on linked expenses. Deleting a liability asks whether to delete its linked expense too; the default keeps it.
- The Cash flow tab adds one stat, "Debt payments", the sum of `monthly_cash_flow` across active liabilities with a linked expense.

### 7. Projections (minimal)

Monte Carlo inputs, outputs, `/api/projections/*` and `/api/v2/projections/*` are unchanged. After a simulation result renders, Projections fetches `GET /api/liabilities` and, when any active debt exists:

- adds a dashed "Median minus debt" trace: `median_values[i] - debt_at_age[i]`, where the debt is the sum of `balance_at` on today's date plus `i` years (pure TS, identical in both modes);
- shows a "Debt payoff" card: "Debt-free by Mar 2052 (age 64)", interest still to pay, and each debt's payoff date.

The card states the limit plainly: "Projections don't move paid-off payments into savings yet." Redirecting freed payments into contributions is deferred (open question 9).

### 8. Existing data: user-initiated conversion only

There is **no automatic migration** of existing positions. Startup never creates liabilities, and a test proves a database with an `RE` position comes out of startup with zero liabilities and an unchanged positions table.

Before this feature, a home or mortgage could only be recorded as a position with ticker `RE`, and such a row is ambiguous: it may hold the home's value, the equity (value minus loan), or the loan itself. The conversion dialog asks, then shows the exact before and after, then waits for a confirm.

Entry points: a "Loan or property" action on real estate rows in Holdings (a third inline action, on those rows only), the dashboard "Is Home financed?" attention item, and the mortgage step of the wizard ("Already tracking this home? Pick it").

Step 1, "What does *Home* ($612,000) represent?":
- **The home's value.** The position is untouched. The user enters the mortgage details; the new mortgage links to this position.
- **My equity (value minus what I owe).** The user enters the home's market value and the loan balance (prefilled so they add up to the current value). On confirm the position's value becomes the home value (`current_price` only; cost basis untouched) and a mortgage for the loan balance is created and linked.
- **The loan itself.** The user confirms the balance (prefilled with the absolute value). On confirm a mortgage is created with that balance, the position is deleted, and, if the user ticks "Also add the home", a property account and real estate position are created and linked.

Step 2 is the mortgage details (the wizard's mortgage step). Step 3, the confirm screen, lists every change ("Home: value $612,000 to $860,000", "New debt: Mortgage $248,000", "Removed position: RE", "New expense: Mortgage $1,980/mo") and the effect: "Portfolio value $1.43M to $1.68M. Net worth $1.43M (unchanged)." The Confirm button names the action ("Convert to mortgage").

Every conversion records `source='converted_position'`, `source_ref=<position id>` and `source_detail` JSON holding the original position row and the ids of anything created. A "Undo conversion" action on the liability (Debts detail) calls a revert endpoint that restores the original position row (same id) or its original value, and deletes the liability, its snapshots and anything the conversion created, after its own confirm. Both convert and revert run in one transaction in each path.

### 9. Wizard

Built on `createDynamicModal` with `showFooter: false` and its own footer, in `src/web/src/features/debt-wizard.ts` (feature chunk). Field definitions, defaults and validation live in a pure module `src/web/src/utils/debt-fields.ts`, shared with the Debts page edit form.

1. **Type.** Seven large choices with an icon and a one-line hint ("Mortgage: a loan on a home").
2. **Details.** Type-specific questions, defaults prefilled, advanced fields (original principal, origination date, lender, owner) behind "More details". Mortgage first asks about the home: "Pick a home you already track" (real estate positions), "Add the home's value" (name, market value, optional purchase price and date; creates a `property` account named "Real estate" if none exists, plus the position), or "Skip". The payment field shows "Calculated: $3,201.73" until the user overrides it.
3. **Review.** Payoff date, payments left, total interest left, this year's principal and interest, a small balance sparkline, and the cash flow choice (decision 6). "Never pays off at this payment" blocks Save with an explanation.
4. **Save.** One `POST /api/liabilities` call carrying the liability plus optional `property` and `cash_flow` instructions, applied atomically. Success shows "Add another debt" and "Done".

Phones (768px and below): the modal is a full-screen sheet with a sticky footer (Back, Next), a "Step 2 of 4" indicator, numeric inputs with `inputmode="decimal"`, and 44px targets. Focus moves to each step's heading; Escape and the close button ask before discarding entered data. Both themes use the existing CSS variables. Entry points: the Debts page Add button and empty state, the dashboard attention item, and an "Add a debt" link under the Liabilities group.

### 10. Demo data

Option (b): a deterministic, additive builder rather than making `generate_demo.py` reproduce the whole file. Rewriting `generate_demo.py` to be deterministic would change every demo position, price and entity on the hosted site; the builder changes only what this project adds, and `generate_demo.py` calls it at the end so a full regeneration still includes liabilities.

`scripts/build_demo_liabilities.py` opens `data/demo/demo.db` (refusing any other path), creates the new tables through `Database()`, and upserts by fixed ids:
- Account `demo-property` "Home" (type `property`, entity null), position `demo-home` "Primary Residence" (`RE`, value $685,000, cost basis $650,000, purchased 2022-06-15).
- `demo-mortgage`: Mortgage, "Rocket Mortgage", original $520,000 at 6.25% for 360 months from 2022-07-01, payment computed by the schedule ($3,201.73, matching the existing $3,200 "Mortgage" expense, which it links to; that expense becomes `is_mortgage` with its split), linked to `demo-home`, household.
- `demo-auto`: Auto loan, "Toyota Financial", original $23,900 at 4.9% for 60 months from 2024-03-01, payment $450.00, linked to the existing "Car Payment #1" expense, entity `jane-demo`.
- `demo-card`: Credit card, "Chase Sapphire", APR 22.99%, limit $15,000, paid in full (no expense), entity `john-demo`.
- Twelve monthly reported snapshots per liability ending at the latest month-end (installment loans from the schedule, the card from a seeded walk between $1,800 and $4,600).

Snapshot dates must track `ensure_recent_demo_history`, which re-dates portfolio history at every demo startup. A shared pure function `demo_liability_snapshots(end_date)` in `src/services/demo_liabilities.py` produces the rows; the builder uses it, and `ensure_recent_demo_history` calls it (same `_is_demo_database` guard, same "already current" early return) to rewrite the demo liability snapshots and each demo liability's `current_balance` / `balance_as_of`. The added home lifts the demo's total assets, so the regenerated portfolio history trends to the new total; that is acceptable and correct for a household with a home.

Hosted visitors: the export endpoint adds `liabilities` and `liability_snapshots` (read-only, demo database only, as today), and `seedDemoDatasetIfEmpty` inserts them with `INSERT OR IGNORE`, setting `expense_id` to null because budget data is not part of the export.

`find_duplicate_positions` and `getDuplicates` skip `position_type='real_estate'` so two homes are never "possible duplicates".

### 11. API (both paths)

| Method and path | Purpose |
|---|---|
| `GET /api/liabilities` | list (`?entity_id=`, `?include_archived=true`) with computed fields |
| `POST /api/liabilities` | create; body may include `property` (`{mode: 'link', position_id}` or `{mode: 'create', name, value, cost_basis?, purchase_date?}`) and `cash_flow` (`{mode: 'create', category_id?}`, `{mode: 'link', expense_id}` or `{mode: 'none'}`) |
| `GET /api/liabilities/{id}` | one liability with computed fields, resolved links and missing-link flags |
| `PUT /api/liabilities/{id}` | partial update; `sync_expense` (default true) updates the linked expense; `is_active=false` archives and sets `closed_date` |
| `DELETE /api/liabilities/{id}` | delete the liability and its snapshots; `?delete_expense=true` also deletes the linked expense |
| `GET /api/liabilities/{id}/history` | reported snapshots plus a computed monthly series |
| `POST /api/liabilities/{id}/balance` | record a reported balance (`balance`, `as_of` default today); updates `current_balance` / `balance_as_of` when it is the newest |
| `POST /api/liabilities/convert-position` | conversion (decision 8), PR C |
| `POST /api/liabilities/{id}/revert-conversion` | undo a conversion, PR C |

Changed, additively: `GET /api/dashboard/data`, `GET /api/settings/demo-mode/export` (plus the hosted seed), `GET /api/portfolio/duplicates`.

Server writes call `check_demo_mode_write()` (blocked on the protected hosted demo). Validation: balance and amounts 0 to 1e10, APR 0 to 1, term 1 to 600 months, name 1 to 120 characters, enums checked, dates ISO.

### 12. Security and privacy

- All data reaches the DOM through `textContent` and `createElement`; no `innerHTML` with data, including chart hover text built from names.
- No balances, payments, names or lenders in logs on either path. Server errors log the exception type and liability id at most; `console.error` gets error objects, never request bodies. FastAPI 422 responses echo input, so the frontend shows a generic "Check the highlighted fields" message rather than rendering `detail` verbatim.
- `source_detail` is never rendered raw.

## Out of scope

Statement upload and categorization (project 3), connections (project 4), extra-payment and payoff-strategy planners (avalanche, snowball), variable rates, interest-only periods on installment loans, escrow modeling beyond a flat amount, a liabilities CSV export, and restoring liabilities from the JSON backup.

## Delivery

Three pull requests, each mergeable on its own (plan: `plans/2026-10-04-liabilities-plan.md`):

- **A. Data.** Tables in both schemas, amortization, API in both paths, dashboard payload, demo data, tests. No visible change except the demo's new home.
- **B. UI.** Dashboard net worth, Debts page with a plain add and edit form, cash flow and Projections integration.
- **C. Wizard and conversion.**

## Verification

Every PR: both data modes (server with `PORTFOLIO_DEMO_MODE=true` on a scratch data dir, and hosted emulation), light and dark themes, 1440, 390 and 360px wide; frontend `typecheck`, `test`, `lint` and `build`; `ruff`, `mypy` and `pytest`; `check_layout.py` with 0 problems including the new `debts` tab. Every schema change is first verified against a copy of `demo.db` (pre-existing tables byte-for-byte unchanged, opening twice is a no-op), never against a real database.
