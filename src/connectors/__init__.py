"""Bank data connectors (design plans/2026-10-06-connections-design.md).

A stateless core: provider protocol, an allowlisted HTTP client, providers and
the mapping onto NormalizedStatement. Nothing in this package opens a database,
writes a file or logs credentials, account names, descriptions or amounts.
"""
