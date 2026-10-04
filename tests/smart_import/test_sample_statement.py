"""The bundled synthetic sample statement (demo experience for smart import)."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.services.demo_liabilities import _CARD_BALANCES
from src.smart_import.analyze import analyze_file
from src.smart_import.recurring import detect
from src.smart_import.seed_rules import SEED_RULES

SAMPLES = Path(__file__).resolve().parents[2] / "src" / "web" / "src" / "samples"
CHECKING = SAMPLES / "sample-checking.csv"
CARD = SAMPLES / "sample-card.ofx"

CATEGORIES = [
    {"id": f"cat-{i}", "name": name}
    for i, name in enumerate(sorted({name for _, name in SEED_RULES}))
]

REAL_INSTITUTIONS = [
    "chase",
    "wells fargo",
    "bank of america",
    "citi",
    "capital one",
    "usaa",
    "discover",
    "american express",
    "navy federal",
    "us bank",
    "pnc",
]


def _analyze(path: Path) -> list[dict]:
    result = analyze_file(path.read_bytes(), path.name, {"categories": CATEGORIES})
    assert result["status"] == "ok", result
    return result["statements"]


@pytest.mark.parametrize("path", [CHECKING, CARD], ids=lambda p: p.name)
def test_sample_files_exist_and_are_clean(path: Path):
    text = path.read_text(encoding="utf-8")
    assert chr(0x2014) not in text
    assert "sample bank" in text.lower()
    lowered = text.lower()
    for name in REAL_INSTITUTIONS:
        assert name not in lowered


@pytest.mark.parametrize("path", [CHECKING, CARD], ids=lambda p: p.name)
def test_every_expense_row_gets_a_seed_category(path: Path):
    statements = _analyze(path)
    expenses = [
        t for s in statements for t in s["transactions"] if t["kind"] == "expense"
    ]
    assert len(expenses) >= 10
    for tx in expenses:
        assert tx["category_source"] == "seed", tx["description"]
        assert tx["category_id"] is not None


def test_checking_sample_shape():
    (stmt,) = _analyze(CHECKING)
    assert stmt["format"] == "csv"
    assert any(t["kind"] == "income" for t in stmt["transactions"])
    assert any(t["kind"] == "payment" for t in stmt["transactions"])


def test_card_sample_closing_balance_matches_demo_credit_card():
    (stmt,) = _analyze(CARD)
    assert stmt["account"]["kind"] == "credit_card"
    assert stmt["closing_balance"]["amount"] == _CARD_BALANCES[-1]


def test_recurring_finds_rent_streaming_and_phone():
    (stmt,) = _analyze(CHECKING)
    found = detect(stmt["transactions"], [], [], CATEGORIES)
    keys = " ".join(c["merchant_key"] for c in found)
    assert len(found) >= 3
    assert "RENT" in keys
    assert "NETFLIX" in keys or "SPOTIFY" in keys
    assert "VERIZON" in keys
    assert all(c["frequency"] == "monthly" for c in found)


def test_recurring_leaves_everyday_grocery_and_gas_visits_out():
    # Groceries and fuel come 2 or 3 times a month on irregular days with spread
    # amounts, so neither statement alone nor both together make them bills.
    checking = _analyze(CHECKING)[0]["transactions"]
    card = _analyze(CARD)[0]["transactions"]
    for rows in (checking, checking + card):
        keys = {c["merchant_key"] for c in detect(rows, [], [], CATEGORIES)}
        for everyday in ("SAFEWAY", "TRADER", "WHOLE FOODS", "SHELL"):
            assert not any(everyday in k for k in keys), (everyday, keys)
        assert any("RENT" in k for k in keys)
        assert any("VERIZON" in k for k in keys)
        assert any("SPOTIFY" in k for k in keys)
