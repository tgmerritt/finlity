# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [Open-source release] - 2026-10-07

Finlity went public under the MIT License on 2026-09-28. This entry covers the public release and the work merged since (pull requests #1 to #19). No tagged release exists yet.

### Added

- Automated and drag-and-drop import of brokerage CSV and Excel exports, with AI-assisted account type detection.
- Multi-account and multi-profile support, including retirement, taxable, and custom account types, so financial advisors can manage separate portfolios for multiple clients.
- Risk-adjusted analysis: Sharpe and Sortino ratios, max drawdown, VaR, CVaR, beta vs. the S&P 500, sector/geography/style/cap-size allocation breakdowns, and configurable allocation triggers.
- Monte Carlo retirement projections with year-by-year withdrawal tables and black swan/golden swan modeling.
- Budget and paycheck tools for tracking income, expenses, and cash flow alongside investment holdings.
- An extensible plugin system, including a marketplace for installing third-party plugins from Git repositories or ZIP files (see `docs/PLUGIN_ARCHITECTURE.md`).
- A hosted, local-first browser mode with synthetic demo data at https://app.finlity.net, so the app can be evaluated without installing anything.
- Redesigned dashboard: an overview-first home page, a page toolbar, a first-run empty state, and a bottom tab bar on phones (#2, #3, #5, #6).
- Net worth and liabilities: a Debts page, a debt wizard, debt-aware cash flow and projections, and converting a real estate row into a mortgage with undo (#8, #9, #10).
- Smart import: a wizard for CSV, OFX/QFX, and text PDF statements with categorization (saved rules first, optional AI), recurring bill detection, a review table, full undo, import history, and planned vs. actual spending (#11, #12, #13).
- Bank connections in Settings through SimpleFIN Bridge and Akahu, with sealed credentials and a synthetic demo bank. Each sync goes through the smart import review. Off by default on shared deployments (#15, #16, #17; see `docs/deployment/heroku.md`).

### Changed

- Relicensed under the standard MIT License.
- The landing page links to the public GitHub repository (#1).

### Fixed

- Prices that predate the last market close are refreshed, and the refresh reports market closed when the gate says so (#4, #19).
- Phone layout, cash-flow cards, drawer accessibility, and console errors on the hosted Taxes and Settings plugins (#2, #7, #14).
- A real statement line in the PDF parser fixtures was replaced with a synthetic one (#18).

[Unreleased]: https://github.com/tgmerritt/finlity/commits/main
