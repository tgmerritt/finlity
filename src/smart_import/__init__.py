"""Stateless smart import core: limits, normalization, parsers, seed rules.

Nothing in this package opens a database or writes a file. It turns uploaded
statement bytes into the NormalizedStatement contract (see types.py) and is
shared by server mode and hosted mode through the /api/v2/smart-import routes.
"""
