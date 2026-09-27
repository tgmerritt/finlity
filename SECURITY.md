# Security Policy

Finlity stores sensitive financial data locally: account balances, holdings, and (in multi-user mode) other people's portfolio data. We take security reports seriously and appreciate the effort that goes into finding and reporting issues responsibly.

## Supported Versions

Finlity is a single-branch project. Only the latest code on `main` is supported with security fixes. There are no separate long-term-support releases; if you're running an older tagged version, please update to the latest `main` before reporting an issue, in case it's already fixed.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using one of these channels:

1. **GitHub private vulnerability reporting** (preferred): go to the repository's Security tab and select "Report a vulnerability." This creates a private advisory that only maintainers can see.
2. **Email**: feedback@finlity.net

### What to Include

To help us triage quickly, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof-of-concept if you have one
- The affected version or commit
- Whether the issue requires authentication, local access, or a specific configuration (e.g. multi-user mode) to exploit

Please do not include real financial data, account numbers, or other personal information in your report; use synthetic or demo data to illustrate the issue.

### Scope

Finlity is a self-hosted app that stores sensitive financial data locally, so the following categories are in scope and especially appreciated:

- Path traversal (file import, plugin loading, static file serving)
- Authentication or authorization bypass in multi-user mode
- Exposure of secrets or API keys (in logs, responses, error messages, or the client bundle)
- Cross-site scripting (XSS) in any user- or import-supplied data rendered in the dashboard

The hosted demo at app.finlity.net runs against synthetic demo data only; there is no real financial data to compromise there, but the demo is still in scope for vulnerabilities in the application itself.

### Response Expectations

Finlity is a volunteer-maintained open source project. We'll do our best to:

- Acknowledge your report within about a week
- Give you an initial assessment of severity and whether it's accepted
- Keep you updated as a fix is developed
- Credit you in the advisory and release notes, if you'd like

We can't promise a fixed timeline for a patch, since it depends on severity and maintainer availability, but we'll communicate status along the way.

Thank you for helping keep Finlity and its users safe.
