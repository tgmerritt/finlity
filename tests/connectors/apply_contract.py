"""What the smart import wizard does to an analyze or connector statement
before it sends Apply: drop the analyze-only fields, add the account label,
each row's dedupe key and, for a connector statement, the connection it came
from (``connection_id``, plan B3). Shared by the mapping tests and the v2 route tests so
both check the same contract (the browser path is PR C's vitest, see
``tests/fixtures/connectors/statements/simplefin_sync.json``)."""

from __future__ import annotations

from typing import Any

# The connection the tests apply connector statements with. A server test that
# applies them needs it stored (``tests.api.si_support.add_connection``).
CONNECTION_ID = "0f0e0d0c-0b0a-4908-8706-050403020100"


def as_apply(st: dict[str, Any], connection_id: str = CONNECTION_ID) -> dict[str, Any]:
    """One statement as the wizard puts it in an ``ApplyRequest``."""
    key = st["account"]["key"]
    out = {k: v for k, v in st.items() if k not in ("extras", "warnings")}
    if st["origin"] == "connector":
        out["connection_id"] = connection_id
    out["account"] = {**st["account"], "label": None}
    out["transactions"] = [
        {
            **{k: v for k, v in t.items() if k not in ("row", "dedupe_base")},
            "dedupe_key": f"{key}|{t['dedupe_base']}",
        }
        for t in st["transactions"]
    ]
    return out
