"""Typed shapes for the NormalizedStatement contract (design section 4.6)."""

from __future__ import annotations

from typing import Literal, TypedDict

Kind = Literal["expense", "income", "transfer", "payment", "refund", "fee", "interest"]
AccountKindName = Literal["checking", "savings", "credit_card", "loan", "unknown"]
CategorySource = Literal["rule", "seed", "none"]

KINDS: tuple[str, ...] = (
    "expense",
    "income",
    "transfer",
    "payment",
    "refund",
    "fee",
    "interest",
)
ACCOUNT_KINDS: tuple[str, ...] = (
    "checking",
    "savings",
    "credit_card",
    "loan",
    "unknown",
)
ORIGINS: tuple[str, ...] = ("file", "sample", "connector")

# Every code a parser may put in NormalizedStatement.warnings (design 4.6).
# Codes only: the client owns the wording, and no code carries file content.
WARNINGS: tuple[str, ...] = (
    "rows_skipped",  # rows without a usable date or amount were left out
    "available_balance_used",  # OFX deposit account had AVAILBAL, no LEDGERBAL
    "duplicate_fitid",  # a repeated OFX FITID; later rows dedupe without it
    "truncated_file",  # OFX ended mid-list; complete rows were kept
    "year_assumed",  # PDF dates had no year and no period; this year was used
    "sign_assumed",  # PDF checking amount had no sign or balance to check it
    "date_order_assumed",  # CSV dates fit month-first and day-first; mdy used
    "sign_flipped",  # CSV used positive for spending; amounts were negated
    "ai_extracted",  # PDF rows were read by the AI extract route
    "ai_partial",  # AI extract ran out of time; only the rows read so far
    # Connectors (connections design 5.4):
    "connector_account_error",  # provider reported an account problem; others synced
    "connector_partial",  # pagination stopped at the page cap; window end moved back
    "connector_balance_only",  # the account returned a balance and no transactions
    "currency_unsupported",  # not a 3-letter ISO currency; the account was skipped
    "connector_sign_check",  # card balance reads as credit while most rows are charges
    "connector_balance_dropped",  # balance undated or dated in the future; left out
)

# Only these kinds are categorized and counted as spending (design 6.1).
CATEGORIZABLE_KINDS: frozenset[str] = frozenset(
    {"expense", "fee", "interest", "refund"}
)


class AccountInfo(TypedDict):
    kind: str
    key: str | None
    last4: str | None
    institution: str | None


class Period(TypedDict):
    start: str | None
    end: str | None


class ClosingBalance(TypedDict):
    """The statement's closing balance.

    Checking, savings and unknown accounts: the plain balance (negative when
    overdrawn). Card and loan accounts: the amount owed, positive when money
    is owed and negative when the account is in credit. Each parser converts
    from its source's own convention:

    * OFX: LEDGERBAL is from the holder's side (negative when owed), so the
      amount owed is ``-BALAMT``.
    * PDF: a printed "New Balance" is owed; a minus sign, parentheses or CR
      mark a credit balance.
    * CSV: read from the running balance against the amounts (balance moving
      with spending is the issuer's side, against it the holder's side); with
      too few rows to tell, a file whose spending is negative is taken as the
      holder's side and a sign-flipped file as the issuer's side.
    """

    amount: float
    as_of: str


class Extras(TypedDict, total=False):
    minimum_payment: float
    payment_due: str


class NormalizedTransaction(TypedDict):
    row: int
    posted_date: str
    amount: float
    description: str
    merchant_key: str
    kind: str
    category_id: str | None
    category_source: str
    external_id: str | None
    dedupe_base: str


class NormalizedStatement(TypedDict):
    file_hash: str
    file_name: str
    origin: str
    format: str
    parser: str
    account: AccountInfo
    period: Period
    closing_balance: ClosingBalance | None
    extras: Extras | None
    warnings: list[str]
    transactions: list[NormalizedTransaction]
