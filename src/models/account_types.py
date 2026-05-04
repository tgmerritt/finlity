"""Predefined account types for the portfolio system."""

from typing import cast

# Predefined account types (used for UI dropdowns, folder suggestions)
# Custom types are stored as "custom:{user_name}" in the database
PREDEFINED_ACCOUNT_TYPES = {
    # Retirement accounts
    "traditional_401k": {
        "label": "Traditional 401(k)",
        "is_retirement": True,
        "description": "Employer-sponsored pre-tax retirement account",
    },
    "roth_401k": {
        "label": "Roth 401(k)",
        "is_retirement": True,
        "description": "Employer-sponsored after-tax retirement account",
    },
    "traditional_ira": {
        "label": "Traditional IRA",
        "is_retirement": True,
        "description": "Individual pre-tax retirement account",
    },
    "roth_ira": {
        "label": "Roth IRA",
        "is_retirement": True,
        "description": "Individual after-tax retirement account",
    },
    "pension": {
        "label": "Pension",
        "is_retirement": True,
        "description": "Defined benefit pension plan",
    },
    "hsa": {
        "label": "Health Savings Account",
        "is_retirement": True,  # Triple tax advantaged
        "description": "Tax-advantaged medical savings account",
    },
    # Non-retirement accounts
    "taxable": {
        "label": "Taxable Brokerage",
        "is_retirement": False,
        "description": "Regular taxable investment account",
    },
    "529": {
        "label": "529 College Savings",
        "is_retirement": False,
        "has_beneficiary": True,
        "description": "Tax-advantaged education savings account",
    },
    "hysa": {
        "label": "High-Yield Savings",
        "is_retirement": False,
        "description": "High-yield savings account",
    },
    "checking": {
        "label": "Checking Account",
        "is_retirement": False,
        "description": "Bank checking account",
    },
    "savings": {
        "label": "Savings Account",
        "is_retirement": False,
        "description": "Bank savings account",
    },
    "treasury_direct": {
        "label": "Treasury Direct",
        "is_retirement": False,
        "description": "Government bonds (I-bonds, T-bills, etc.)",
    },
    "property": {
        "label": "Property",
        "is_retirement": False,
        "description": "Real Estate including land and buildings",
    },
    "misc": {
        "label": "Miscellaneous",
        "is_retirement": False,
        "description": "Other assets with a cost basis & present value (artwork, memorabilia, etc.)",
    },
}


def get_account_type_label(account_type: str) -> str:
    """Get human-readable label for an account type."""
    if account_type.startswith("custom:"):
        return account_type[7:]  # Strip "custom:" prefix
    return cast(str, PREDEFINED_ACCOUNT_TYPES.get(account_type, {}).get("label", account_type))  # dict values are str at "label" key


def is_retirement_account(account_type: str) -> bool:
    """Check if an account type is a retirement account."""
    return cast(bool, PREDEFINED_ACCOUNT_TYPES.get(account_type, {}).get("is_retirement", False))  # dict values are bool at "is_retirement" key


def get_folder_name(account_type: str) -> str:
    """Get the import folder name for an account type."""
    if account_type.startswith("custom:"):
        # Sanitize custom name for folder
        name = account_type[7:].lower()
        name = "".join(c if c.isalnum() or c == "_" else "_" for c in name)
        return f"custom_{name}"
    return account_type


def get_all_predefined_types() -> list[dict]:
    """Get all predefined account types for UI dropdowns."""
    return [
        {"value": key, **value}
        for key, value in PREDEFINED_ACCOUNT_TYPES.items()
    ]
