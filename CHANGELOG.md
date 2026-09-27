# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - Unreleased

First public, open source release of Finlity.

### Added

- Automated and drag-and-drop import of brokerage CSV and Excel exports, with AI-assisted account type detection.
- Multi-account and multi-profile support, including retirement, taxable, and custom account types, so financial advisors can manage separate portfolios for multiple clients.
- Risk-adjusted analysis: Sharpe and Sortino ratios, max drawdown, VaR, CVaR, beta vs. the S&P 500, sector/geography/style/cap-size allocation breakdowns, and configurable allocation triggers.
- Monte Carlo retirement projections with year-by-year withdrawal tables and black swan/golden swan modeling.
- Budget and paycheck tools for tracking income, expenses, and cash flow alongside investment holdings.
- An extensible plugin system, including a marketplace for installing third-party plugins from Git repositories or ZIP files (see `docs/PLUGIN_ARCHITECTURE.md`).
- A hosted, local-first browser mode with synthetic demo data, so the app can be evaluated without installing anything.
- Relicensed under the standard MIT License.

[Unreleased]: https://github.com/tgmerritt/finlity/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tgmerritt/finlity/releases/tag/v1.0.0
