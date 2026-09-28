# Dashboard redesign: overview first

Status: proposed, 2026-09-28. First of four projects (dashboard, liabilities, smart import, connections).

## Goal

Finlity should be a low-effort personal finance dashboard with advanced tools for people who want them. The dashboard has to answer three questions at a glance, on a phone as well as a desktop:

1. How much do I have?
2. How did it change?
3. Am I on track?

Advanced tools (Monte Carlo, FIRE, detailed breakdowns) stay, one click away rather than on the main view.

## User-visible changes at a glance

- The Welcome page leaves the in-app navigation. The app opens on the Dashboard. Marketing content lives on www.finlity.net.
- Both dashboard pie charts are removed. Asset allocation becomes horizontal bars by asset class, compared with targets. "By Account Type" is dropped because it duplicated the accounts table.
- The nine KPI tiles are consolidated. Portfolio value and total gain move into the hero, the Retirement and Taxable totals become account-group subtotals, and coast number, FIRE number, earliest retirement age and retirement income move to Projections.
- On phones, a bottom tab bar replaces the hamburger menu.
- The View and Person filters move from the sidebar into the page header.
- Monte Carlo is never run automatically on page load (in hosted mode each run is a server call). The dashboard shows the last stored result, or a one-click check.

## Dashboard layout

Desktop, top to bottom:

1. **Page header.** Title, View and Person filters as compact selects, price freshness ("Prices updated 2h ago") and the refresh action.
2. **Hero card.** Portfolio value in large type, today's change in dollars and percent, the change over the selected chart range, and total gain since purchase (the old "Total Gain/Loss" tile). The value history chart sits inside the same card, directly below the numbers. Range buttons: 1M, 3M, YTD, 1Y, All. The default is the longest range that has data. With fewer than two snapshots, the chart area shows "Your history builds as Finlity records a daily snapshot." instead of an empty plot. The x axis shows dates, never times.
   - Net-worth slot: reserved in the hero, rendered only when liabilities exist (project 2). This project ships it hidden, with no liabilities code.
3. **Three cards in a row** (stacked on phones):
   - **Allocation vs target.** One horizontal bar per asset class (stocks, bonds, cash, alternatives), showing actual percent with a target marker and a drift badge when outside a 5 percentage point band. With no targets set, it shows actual allocation plus a "Set targets" link to Settings. Hosted visitors start with no targets.
   - **On track.** A single signal: the success probability from the most recent stored Monte Carlo result, its date, and a link to Projections. Without a real birth date (unset or the `1990-01-01` placeholder) it shows "Add your birth date to see if you're on track" with a link to Settings. With a birth date but no stored result, it shows a "Run a quick check" button, which runs a 1,000-path simulation, stores it, and never blocks the rest of the page.
   - **Needs attention.** A short list built only from data the app already has: stale prices, CDs maturing within 60 days, possible duplicate positions, triggered allocation alerts. With nothing to report it reads "All clear".
4. **Accounts.** A list grouped into Retirement, Taxable and Cash & savings. Each row shows account name, value, percent of total and today's change. Group headers show subtotals. Selecting a row opens Holdings filtered to that account. This replaces the Account Balances table and the By Account Type pie.

Phones (640px and below): a single column in the same order. The hero value uses fluid type (`clamp`) so it never truncates. The account list is the phone layout, with no table to clip.

## Navigation

- Desktop keeps the sidebar: Dashboard, Holdings, Analysis, Projections, Expenses & Income, Taxes, Settings. Welcome is removed.
- Phones get a fixed bottom tab bar: Dashboard, Holdings, Projections, Cash flow (Expenses & Income), More. More opens a sheet with Analysis, Taxes and Settings. The chat button moves above the tab bar and shrinks.
- First run with an empty database: the dashboard shows an empty state with three actions (import a brokerage or bank file, add an account by hand, explore demo data) instead of zero-valued cards.
- The demo banner becomes a slim bar that can be dismissed for the session.

## Other pages

- **Holdings.** Rows grouped by account under subtotal headers (a toggle turns grouping off), row actions collapsed into a single overflow menu, and on phones each position rendered as a card showing ticker, name, value and gain.
- **Projections.** Gains the tiles moved off the dashboard. On phones the inputs collapse into a panel above the results.
- **Settings.** Split into sections with a sticky section index on desktop and an accordion on phones: Profile & goals, Targets, Market assumptions, Data sources, Import & export, Plugins, Advanced.
- **Charts everywhere.** Plotly charts are responsive (`responsive: true`, autosize, legends below the plot on phones) and chart containers get `min-width: 0` so no chart overflows its card.

## Data

Two data paths serve the frontend: the FastAPI server (self-hosted) and `LocalAPI` in the browser (hosted, via `src/web/src/api/dispatcher.ts`). Every data change lands in both, with a test that runs one fixture through both and compares the output.

- **Today's change.** `previous_close` per position is added to the `/api/dashboard/data` response in both paths (`src/main.py` and the `dispatcher.ts` route). The frontend computes position, account and portfolio day change from it. Positions without a previous close (CDs, cash, manual entries) count as unchanged.
- **Asset class.** Derived in the frontend from fields positions already carry (`position_type`, fund metadata), so no new field is needed.
- **Demo history.** Both demo seed paths (`scripts/generate_demo.py` for `demo.db`, and the hosted browser seeding) generate about a year of daily synthetic snapshots so the hero chart has something to show.
- **Default targets.** `config.yaml` targets become neutral defaults (a simple 60/40-style split) instead of one person's allocation.

Out of scope: liabilities, statement categorization and bank connections (projects 2 to 4).

## Delivery

Four pull requests, least controversial first, so each can merge on its own. Merging deploys to app.finlity.net, so none are merged without review.

1. **Layout fixes, no new data.** Phone breakages (truncated total, squashed tiles, clipped tables and charts), responsive Plotly, the history chart axis, the chat button position.
2. **Dashboard restructure.** Hero with day change, allocation vs target, on track, needs attention, grouped accounts, demo history, neutral default targets, and the both-paths parity test.
3. **Navigation.** Filters into the page header, bottom tab bar, Welcome out of the app nav, first-run empty state, slim demo banner.
4. **Holdings, Projections, Settings.**

The demo data bugs (cash positions valued at about $1 with a 99.98% loss, VGT at an 81% loss) are fixed on a separate branch after being reproduced in both data paths.

## Verification

Every pull request is checked in both data modes (server with `PORTFOLIO_DEMO_MODE=true` and a scratch data directory, and hosted browser storage), in light and dark themes, at 1440, 390 and 360px wide. The frontend `typecheck`, `test`, `lint` and `build` scripts pass. `app.js` stays around 8 KB, with new code in the existing chunk groups.
