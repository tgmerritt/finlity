"""What the smart import wizard does to an analyze or connector statement
before it sends Apply: drop the analyze-only fields, add the account label and
each row's dedupe key. Shared by the mapping tests and the v2 route tests so
both check the same contract (the browser path is PR C's vitest, see
``tests/fixtures/connectors/statements/simplefin_sync.json``)."""

from __future__ import annotations

from typing import Any


def as_apply(st: dict[str, Any]) -> dict[str, Any]:
    """One statement as the wizard puts it in an ``ApplyRequest``."""
    key = st["account"]["key"]
    out = {k: v for k, v in st.items() if k not in ("extras", "warnings")}
    out["account"] = {**st["account"], "label": None}
    out["transactions"] = [
        {
            **{k: v for k, v in t.items() if k not in ("row", "dedupe_base")},
            "dedupe_key": f"{key}|{t['dedupe_base']}",
        }
        for t in st["transactions"]
    ]
    return out
