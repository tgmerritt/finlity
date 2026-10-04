#!/usr/bin/env python3
"""Add the demo home and debts to data/demo/demo.db (additive and idempotent).

Run from the repo root: python scripts/build_demo_liabilities.py

Refuses any path that is not the demo database (symlinks are resolved and refused).
Never run this against a real database, and never use generate_demo.py on the
tracked file; this script is the only supported way to change it.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.database.operations import Database  # noqa: E402
from src.services.demo_liabilities import DemoBuilderError, build_demo_liabilities, resolve_demo_target  # noqa: E402


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="data/demo/demo.db", help="must resolve to the demo database")
    args = parser.parse_args(argv)
    try:
        target = resolve_demo_target(args.db)
        db = Database(str(target))
        try:
            build_demo_liabilities(db)
        finally:
            db.engine.dispose()
    except DemoBuilderError as exc:
        print(f"build_demo_liabilities: {exc}", file=sys.stderr)
        return 1
    print("Demo liabilities built.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
