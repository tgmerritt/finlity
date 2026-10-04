"""OFX 1.x (SGML) and 2.x (XML) / QFX statement parser (design 4.3, decision K8).

This is a tokenizer, not an XML parser. It never imports an XML library, so
there is no DTD, external entity or entity expansion surface at all:

* every ``<!...`` construct (DOCTYPE, ENTITY, ELEMENT, CDATA, comments) and every
  processing instruction except the leading ``<?xml ...?>`` / ``<?OFX ...?>``
  prolog is rejected with ``unsupported_ofx``;
* only ``&amp; &lt; &gt; &quot; &apos;`` and numeric references are decoded, in a
  single pass, so nothing can expand; any other ``&name;`` stays literal;
* work is linear in the input: one forward scan, an explicit bounded stack (no
  recursion), per-tag and per-value caps from ``limits``.

Error messages are fixed strings (``SmartImportError``); file content never
reaches an exception, log line or warning.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterator
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from ..errors import SmartImportError
from ..limits import (
    MAX_OFX_STATEMENTS,
    MAX_OFX_TAG_NAME,
    MAX_OFX_TAGS,
    MAX_OFX_VALUE_CHARS,
    MAX_TRANSACTIONS_PER_STATEMENT,
)
from ..normalize import (
    account_key_from_number,
    assign_occurrences,
    dedupe_base,
    finalize_statement,
    infer_kind,
    mask_description,
    merchant_key,
)
from ..types import ClosingBalance, NormalizedStatement, NormalizedTransaction

# Real OFX nests about 8 levels deep; anything past this is hostile or broken.
MAX_OFX_DEPTH = 64

_TAG_RE = re.compile(
    r"<(/?)([A-Za-z][A-Za-z0-9_.]{0,%d})(/?)>" % (MAX_OFX_TAG_NAME - 1)
)
_LONG_NAME_RE = re.compile(r"</?[A-Za-z][A-Za-z0-9_.]{%d,}" % MAX_OFX_TAG_NAME)
_PROLOG_RE = re.compile(r"<\?(?:xml|OFX)(?=[\s?])[^<>]{0,2000}\?>")
_ENTITY_RE = re.compile(r"&(amp|lt|gt|quot|apos|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});")
_NAMED = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}
_AMOUNT_RE = re.compile(r"[+-]?[0-9]{1,15}(?:\.[0-9]{1,6})?")
_CHARSET_RE = re.compile(r"CHARSET\s*:\s*([A-Za-z0-9_-]+)", re.IGNORECASE)
_XML_ENC_RE = re.compile(r"""encoding\s*=\s*["']([A-Za-z0-9_-]+)["']""", re.IGNORECASE)

_CP1252 = {"1252", "WINDOWS-1252", "CP1252", "WINDOWS1252"}
_LATIN1 = {"ISO-8859-1", "ISO8859-1", "8859-1", "LATIN1", "LATIN-1"}
_TRUNCATION_NAMES = frozenset({"STMTTRN", "STMTRS", "CCSTMTRS", "BANKTRANLIST"})

_ACCT_KINDS = {
    "CHECKING": "checking",
    "SAVINGS": "savings",
    "MONEYMRKT": "savings",
    "CD": "savings",
    "CREDITLINE": "loan",
}


class _Node:
    __slots__ = ("name", "value", "children", "closed")

    def __init__(self, name: str, value: str | None = None) -> None:
        self.name = name
        self.value = value  # set for leaves only
        self.children: list[_Node] = []
        self.closed = value is not None


def _fail(error_type: str) -> SmartImportError:
    return SmartImportError(error_type)


# ---------------------------------------------------------------------------
# Decoding
# ---------------------------------------------------------------------------


def _decode(content: bytes) -> str:
    """Decode per BOM, then CHARSET / XML encoding, then UTF-8 with cp1252 fallback."""
    if content.startswith(b"\xef\xbb\xbf"):
        try:
            text = content[3:].decode("utf-8")
        except UnicodeDecodeError:
            raise _fail("unreadable") from None
    elif content.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            text = content.decode("utf-16")
        except UnicodeDecodeError:
            raise _fail("unreadable") from None
    else:
        head = content[:2048].decode("ascii", "ignore")
        m = _CHARSET_RE.search(head) or _XML_ENC_RE.search(head)
        charset = m.group(1).upper() if m else ""
        if charset in _CP1252:
            text = content.decode("cp1252", "replace")
        elif charset in _LATIN1:
            text = content.decode("latin-1")
        else:
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                text = content.decode("cp1252", "replace")
    if "\x00" in text:
        raise _fail("unreadable")
    return text


def _decode_entities(value: str) -> str:
    """Single-pass decode of the five XML entities and numeric references."""
    if "&" not in value:
        return value

    def repl(m: re.Match[str]) -> str:
        ref = m.group(1)
        named = _NAMED.get(ref)
        if named is not None:
            return named
        try:
            code = int(ref[2:], 16) if ref[1] in "xX" else int(ref[1:])
        except ValueError:
            return m.group(0)
        if (
            code in (9, 10, 13)
            or 32 <= code <= 0x10FFFF
            and not 0xD800 <= code <= 0xDFFF
        ):
            return chr(code)
        return m.group(0)

    return _ENTITY_RE.sub(repl, value)


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------


class _Tree:
    def __init__(self) -> None:
        self.root = _Node("")
        self.statements: list[_Node] = []
        self.fi_nodes: list[_Node] = []
        self.has_investment = False
        self.truncated = False


def _tokenize(text: str) -> _Tree:
    tree = _Tree()
    stack: list[_Node] = [tree.root]
    tag_count = 0
    seen_tag = False
    pos = 0
    n = len(text)

    while True:
        lt = text.find("<", pos)
        if lt < 0:
            break
        if text.startswith("<!", lt):
            raise _fail("unsupported_ofx")
        if text.startswith("<?", lt):
            m = _PROLOG_RE.match(text, lt)
            if m is None or seen_tag:
                raise _fail("unsupported_ofx")
            pos = m.end()
            continue
        m = _TAG_RE.match(text, lt)
        if m is None:
            if _LONG_NAME_RE.match(text, lt):
                raise _fail("ofx_too_large")
            if (
                text.find(">", lt, lt + MAX_OFX_TAG_NAME + 4) < 0
                and n - lt <= MAX_OFX_TAG_NAME + 3
            ):
                tree.truncated = True  # file ends inside a tag
                break
            raise _fail("unreadable")

        tag_count += 1
        if tag_count > MAX_OFX_TAGS:
            raise _fail("ofx_too_large")
        seen_tag = True
        closing, raw_name, selfclose = m.group(1), m.group(2).upper(), m.group(3)
        pos = m.end()

        if closing:
            if selfclose:
                raise _fail("unreadable")
            # Pop to the nearest open aggregate with this name; unmatched
            # closers (XML leaf closers, stray closers) are ignored.
            for i in range(len(stack) - 1, 0, -1):
                if stack[i].name == raw_name:
                    for node in stack[i:]:
                        node.closed = True
                    del stack[i:]
                    break
            continue

        nxt = text.find("<", pos)
        end = n if nxt < 0 else nxt
        value = text[pos:end].strip()
        if len(value) > MAX_OFX_VALUE_CHARS:
            raise _fail("ofx_too_large")
        parent = stack[-1]

        if value or selfclose:
            node = _Node(raw_name, _decode_entities(value))
            parent.children.append(node)
            pos = end
            continue

        node = _Node(raw_name)
        parent.children.append(node)
        if len(stack) > MAX_OFX_DEPTH:
            raise _fail("ofx_too_large")
        stack.append(node)
        pos = end
        if raw_name in ("STMTRS", "CCSTMTRS"):
            tree.statements.append(node)
            if len(tree.statements) > MAX_OFX_STATEMENTS:
                raise _fail("ofx_too_large")
        elif raw_name == "INVSTMTRS":
            tree.has_investment = True
        elif raw_name == "FI":
            tree.fi_nodes.append(node)

    if any(node.name in _TRUNCATION_NAMES for node in stack[1:]):
        tree.truncated = True
    return tree


# ---------------------------------------------------------------------------
# Field helpers
# ---------------------------------------------------------------------------


def _child(node: _Node, name: str) -> _Node | None:
    for c in node.children:
        if c.name == name:
            return c
    return None


def _leaf(node: _Node | None, name: str) -> str | None:
    if node is None:
        return None
    c = _child(node, name)
    if c is None or c.value is None:
        return None
    return c.value


def _parse_date(value: str | None) -> date | None:
    if not value or len(value) < 8 or not value[:8].isdigit():
        return None
    try:
        return date(int(value[:4]), int(value[4:6]), int(value[6:8]))
    except ValueError:
        return None


def _parse_amount(value: str | None) -> float | None:
    if value is None:
        return None
    v = value.strip().replace(" ", "")
    if "," in v:
        v = v.replace(",", "") if "." in v else v.replace(",", ".")
    if not _AMOUNT_RE.fullmatch(v):
        return None
    return float(Decimal(v).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _description(name: str | None, payee: str | None, memo: str | None) -> str:
    base = (name or payee or "").strip()
    extra = (memo or "").strip()
    if not base:
        return extra
    if extra and extra.upper() not in base.upper():
        return f"{base} {extra}"
    return base


def _institution(tree: _Tree) -> tuple[str | None, str | None]:
    """Return (display name, id used in the account key)."""
    org = fid = None
    for fi in tree.fi_nodes:
        org = org or _leaf(fi, "ORG")
        fid = fid or _leaf(fi, "FID")
    return (org or fid or None), (fid or org or None)


# ---------------------------------------------------------------------------
# Statement assembly
# ---------------------------------------------------------------------------


def _balance(node: _Node | None) -> tuple[float, date | None] | None:
    amount = _parse_amount(_leaf(node, "BALAMT"))
    if amount is None:
        return None
    return amount, _parse_date(_leaf(node, "DTASOF"))


def _iter_transactions(stmt: _Node) -> Iterator[_Node]:
    tranlist = _child(stmt, "BANKTRANLIST")
    if tranlist is None:
        return
    count = 0
    for c in tranlist.children:
        if c.name == "STMTTRN" and c.value is None and c.closed:
            count += 1
            if count > MAX_TRANSACTIONS_PER_STATEMENT:
                raise _fail("too_many_rows")
            yield c


def _build_statement(
    stmt: _Node,
    tree: _Tree,
    institution_ids: tuple[str | None, str | None],
    file_hash: str,
) -> NormalizedStatement:
    """Assemble one statement; parse_ofx finalizes it (rules, name, origin)."""
    warnings: list[str] = []
    is_card = stmt.name == "CCSTMTRS"
    acct_node = _child(stmt, "CCACCTFROM" if is_card else "BANKACCTFROM")
    acct_type = (_leaf(acct_node, "ACCTTYPE") or "").upper()
    if is_card:
        kind = "credit_card"
    else:
        kind = _ACCT_KINDS.get(acct_type, "unknown")

    institution, inst_id = institution_ids
    acct_id = _leaf(acct_node, "ACCTID")
    digits = "".join(ch for ch in (acct_id or "") if ch.isdigit())
    inst_for_key = inst_id or _leaf(acct_node, "BANKID")
    key = account_key_from_number(inst_for_key, digits) if digits else None
    last4 = digits[-4:] if digits else None

    raw_rows: list[dict[str, Any]] = []
    skipped = False
    seen_fitids: set[str] = set()
    dup_fitid = False
    for t in _iter_transactions(stmt):
        posted = _parse_date(_leaf(t, "DTPOSTED"))
        amount = _parse_amount(_leaf(t, "TRNAMT"))
        if posted is None or amount is None:
            skipped = True
            continue
        payee = _child(t, "PAYEE")
        raw_desc = _description(
            _leaf(t, "NAME"), _leaf(payee, "NAME"), _leaf(t, "MEMO")
        )
        fitid = (_leaf(t, "FITID") or "").strip() or None
        if fitid is not None:
            if fitid in seen_fitids:
                fitid = None
                dup_fitid = True
            else:
                seen_fitids.add(fitid)
        desc = mask_description(raw_desc)
        raw_rows.append(
            {
                "posted_date": posted.isoformat(),
                "amount": amount,
                "description": desc,
                "merchant_key": merchant_key(raw_desc),
                "kind": infer_kind(raw_desc, amount, kind, _leaf(t, "TRNTYPE")),
                "external_id": fitid,
            }
        )

    occurrences = assign_occurrences(raw_rows)
    transactions: list[NormalizedTransaction] = []
    for i, (r, occ) in enumerate(zip(raw_rows, occurrences, strict=True)):
        transactions.append(
            {
                "row": i,
                "posted_date": r["posted_date"],
                "amount": r["amount"],
                "description": r["description"],
                "merchant_key": r["merchant_key"],
                "kind": r["kind"],
                "category_id": None,
                "category_source": "none",
                "external_id": r["external_id"],
                "dedupe_base": dedupe_base(
                    r["posted_date"],
                    r["amount"],
                    r["merchant_key"],
                    r["description"],
                    occ,
                    fitid=r["external_id"],
                ),
            }
        )

    tranlist = _child(stmt, "BANKTRANLIST")
    start = _parse_date(_leaf(tranlist, "DTSTART"))
    end = _parse_date(_leaf(tranlist, "DTEND"))
    start_s: str | None
    end_s: str | None
    if transactions:
        dates = [t["posted_date"] for t in transactions]
        start_s = start.isoformat() if start else min(dates)
        end_s = end.isoformat() if end else max(dates)
    else:
        start_s = start.isoformat() if start else None
        end_s = end.isoformat() if end else None

    closing: ClosingBalance | None = None
    ledger = _balance(_child(stmt, "LEDGERBAL"))
    if ledger is None and kind in ("checking", "savings", "unknown"):
        ledger = _balance(_child(stmt, "AVAILBAL"))
        if ledger is not None:
            warnings.append("available_balance_used")
    if ledger is not None:
        amount, as_of = ledger
        as_of_s = as_of.isoformat() if as_of else end_s
        if as_of_s is not None:
            # OFX balances are from the holder's side: a card or loan owes when
            # negative, so the amount owed is -BALAMT (a credit balance < 0).
            owed = kind in ("credit_card", "loan")
            closing = {"amount": -amount if owed else amount, "as_of": as_of_s}

    if skipped:
        warnings.append("rows_skipped")
    if dup_fitid:
        warnings.append("duplicate_fitid")
    if tree.truncated:
        warnings.append("truncated_file")

    return {
        "file_hash": file_hash,
        "file_name": "",
        "origin": "file",
        "format": "ofx",
        "parser": "ofx",
        "account": {
            "kind": kind,
            "key": key,
            "last4": last4,
            "institution": institution,
        },
        "period": {"start": start_s, "end": end_s},
        "closing_balance": closing,
        "extras": None,
        "warnings": warnings,
        "transactions": transactions,
    }


def parse_ofx(
    content: bytes, file_name: str, context: dict[str, Any]
) -> list[NormalizedStatement]:
    """Parse an OFX 1.x / 2.x / QFX file into one statement per account section."""
    text = _decode(content)
    tree = _tokenize(text)
    if not tree.statements:
        raise _fail("unsupported_ofx" if tree.has_investment else "unreadable")
    file_hash = hashlib.sha256(content).hexdigest()
    institution_ids = _institution(tree)  # once: FI blocks can be many
    return [
        finalize_statement(
            _build_statement(s, tree, institution_ids, file_hash), context, file_name
        )
        for s in tree.statements
    ]
