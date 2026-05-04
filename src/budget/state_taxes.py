"""
State income tax brackets and calculations.

Supports progressive brackets for major states and flat rates for others.
States without income tax return 0.
"""


# State tax brackets for 2024
# Format: [(bracket_max, rate), ...] where rate is applied to income in that bracket
# Brackets are cumulative (like federal brackets)

STATE_TAX_BRACKETS: dict[str, dict[str, list[tuple[float, float]]]] = {
    # California (2024) - 9 brackets
    "CA": {
        "single": [
            (10412, 0.01),
            (24684, 0.02),
            (38959, 0.04),
            (54081, 0.06),
            (68350, 0.08),
            (349137, 0.093),
            (418961, 0.103),
            (698271, 0.113),
            (float('inf'), 0.123),
        ],
        "married_joint": [
            (20824, 0.01),
            (49368, 0.02),
            (77918, 0.04),
            (108162, 0.06),
            (136700, 0.08),
            (698274, 0.093),
            (837922, 0.103),
            (1396542, 0.113),
            (float('inf'), 0.123),
        ],
    },

    # New York (2024) - 9 brackets
    "NY": {
        "single": [
            (8500, 0.04),
            (11700, 0.045),
            (13900, 0.0525),
            (80650, 0.0585),
            (215400, 0.0625),
            (1077550, 0.0685),
            (5000000, 0.0965),
            (25000000, 0.103),
            (float('inf'), 0.109),
        ],
        "married_joint": [
            (17150, 0.04),
            (23600, 0.045),
            (27900, 0.0525),
            (161550, 0.0585),
            (323200, 0.0625),
            (2155350, 0.0685),
            (5000000, 0.0965),
            (25000000, 0.103),
            (float('inf'), 0.109),
        ],
    },

    # New Jersey (2024) - 7 brackets
    "NJ": {
        "single": [
            (20000, 0.014),
            (35000, 0.0175),
            (40000, 0.035),
            (75000, 0.05525),
            (500000, 0.0637),
            (1000000, 0.0897),
            (float('inf'), 0.1075),
        ],
        "married_joint": [
            (20000, 0.014),
            (50000, 0.0175),
            (70000, 0.0245),
            (80000, 0.035),
            (150000, 0.05525),
            (500000, 0.0637),
            (1000000, 0.0897),
            (float('inf'), 0.1075),
        ],
    },

    # Massachusetts (2024) - Flat rate with millionaire's tax
    "MA": {
        "single": [
            (1000000, 0.05),
            (float('inf'), 0.09),  # 4% surtax on income over $1M
        ],
        "married_joint": [
            (1000000, 0.05),
            (float('inf'), 0.09),
        ],
    },

    # Pennsylvania (2024) - Flat rate
    "PA": {
        "single": [(float('inf'), 0.0307)],
        "married_joint": [(float('inf'), 0.0307)],
    },

    # Illinois (2024) - Flat rate
    "IL": {
        "single": [(float('inf'), 0.0495)],
        "married_joint": [(float('inf'), 0.0495)],
    },

    # Ohio (2024) - 4 brackets
    "OH": {
        "single": [
            (26050, 0.0),  # 0% up to this amount
            (46100, 0.02765),
            (92150, 0.03226),
            (float('inf'), 0.03688),
        ],
        "married_joint": [
            (26050, 0.0),
            (46100, 0.02765),
            (92150, 0.03226),
            (float('inf'), 0.03688),
        ],
    },

    # Georgia (2024) - 6 brackets
    "GA": {
        "single": [
            (750, 0.01),
            (2250, 0.02),
            (3750, 0.03),
            (5250, 0.04),
            (7000, 0.05),
            (float('inf'), 0.0549),
        ],
        "married_joint": [
            (1000, 0.01),
            (3000, 0.02),
            (5000, 0.03),
            (7000, 0.04),
            (10000, 0.05),
            (float('inf'), 0.0549),
        ],
    },

    # North Carolina (2024) - Flat rate
    "NC": {
        "single": [(float('inf'), 0.0475)],
        "married_joint": [(float('inf'), 0.0475)],
    },

    # Virginia (2024) - 4 brackets
    "VA": {
        "single": [
            (3000, 0.02),
            (5000, 0.03),
            (17000, 0.05),
            (float('inf'), 0.0575),
        ],
        "married_joint": [
            (3000, 0.02),
            (5000, 0.03),
            (17000, 0.05),
            (float('inf'), 0.0575),
        ],
    },

    # Colorado (2024) - Flat rate
    "CO": {
        "single": [(float('inf'), 0.044)],
        "married_joint": [(float('inf'), 0.044)],
    },

    # Arizona (2024) - Flat rate
    "AZ": {
        "single": [(float('inf'), 0.025)],
        "married_joint": [(float('inf'), 0.025)],
    },

    # Minnesota (2024) - 4 brackets
    "MN": {
        "single": [
            (30070, 0.0535),
            (98760, 0.068),
            (183340, 0.0785),
            (float('inf'), 0.0985),
        ],
        "married_joint": [
            (43950, 0.0535),
            (174610, 0.068),
            (304970, 0.0785),
            (float('inf'), 0.0985),
        ],
    },

    # Oregon (2024) - 4 brackets
    "OR": {
        "single": [
            (4050, 0.0475),
            (10200, 0.0675),
            (125000, 0.0875),
            (float('inf'), 0.099),
        ],
        "married_joint": [
            (8100, 0.0475),
            (20400, 0.0675),
            (250000, 0.0875),
            (float('inf'), 0.099),
        ],
    },

    # No income tax states
    "TX": {"single": [], "married_joint": []},
    "FL": {"single": [], "married_joint": []},
    "WA": {"single": [], "married_joint": []},
    "NV": {"single": [], "married_joint": []},
    "WY": {"single": [], "married_joint": []},
    "AK": {"single": [], "married_joint": []},
    "SD": {"single": [], "married_joint": []},
    "TN": {"single": [], "married_joint": []},  # No income tax on wages
    "NH": {"single": [], "married_joint": []},  # Only interest/dividends tax
}

# Default flat rate for states not in the detailed list
DEFAULT_STATE_RATES = {
    "AL": 0.05,
    "AR": 0.047,
    "CT": 0.0699,
    "DE": 0.066,
    "HI": 0.11,
    "ID": 0.058,
    "IN": 0.0305,
    "IA": 0.06,
    "KS": 0.057,
    "KY": 0.04,
    "LA": 0.0425,
    "ME": 0.0715,
    "MD": 0.0575,
    "MI": 0.0425,
    "MS": 0.05,
    "MO": 0.048,
    "MT": 0.059,
    "NE": 0.0664,
    "NM": 0.059,
    "ND": 0.0195,
    "OK": 0.0475,
    "RI": 0.0599,
    "SC": 0.064,
    "UT": 0.0465,
    "VT": 0.0875,
    "WV": 0.0512,
    "WI": 0.0765,
    "DC": 0.0895,  # District of Columbia
}


def calculate_state_tax(
    annual_income: float,
    state: str,
    filing_status: str = "single",
) -> float:
    """
    Calculate state income tax.

    Args:
        annual_income: Annual taxable income (after pre-tax deductions)
        state: Two-letter state code
        filing_status: 'single', 'married_joint', 'married_separate', or 'head_household'

    Returns:
        Annual state income tax
    """
    state = state.upper()

    if annual_income <= 0:
        return 0.0

    # Normalize filing status
    filing = filing_status.lower().replace(" ", "_")
    if filing in ("married_separate", "head_household"):
        filing = "single"  # Use single rates as approximation

    # Check if we have detailed brackets for this state
    if state in STATE_TAX_BRACKETS:
        brackets = STATE_TAX_BRACKETS[state].get(filing, STATE_TAX_BRACKETS[state].get("single", []))

        if not brackets:
            return 0.0  # No income tax state

        return _calculate_progressive_tax(annual_income, brackets)

    # Use default flat rate if available
    if state in DEFAULT_STATE_RATES:
        return annual_income * DEFAULT_STATE_RATES[state]

    # Unknown state - use conservative estimate
    return annual_income * 0.05


def _calculate_progressive_tax(income: float, brackets: list) -> float:
    """
    Calculate tax using progressive brackets.

    Args:
        income: Taxable income
        brackets: List of (bracket_max, rate) tuples

    Returns:
        Total tax
    """
    tax = 0.0
    prev_bracket = 0

    for bracket_max, rate in brackets:
        if income <= prev_bracket:
            break

        taxable_in_bracket = min(income, bracket_max) - prev_bracket
        tax += taxable_in_bracket * rate
        prev_bracket = bracket_max

    return tax


def get_state_marginal_rate(
    annual_income: float,
    state: str,
    filing_status: str = "single",
) -> float:
    """
    Get the marginal state tax rate for a given income level.

    Args:
        annual_income: Annual taxable income
        state: Two-letter state code
        filing_status: Filing status

    Returns:
        Marginal tax rate as a decimal (e.g., 0.093 for 9.3%)
    """
    state = state.upper()

    if annual_income <= 0:
        return 0.0

    filing = filing_status.lower().replace(" ", "_")
    if filing in ("married_separate", "head_household"):
        filing = "single"

    if state in STATE_TAX_BRACKETS:
        brackets = STATE_TAX_BRACKETS[state].get(filing, STATE_TAX_BRACKETS[state].get("single", []))

        if not brackets:
            return 0.0

        for bracket_max, rate in brackets:
            if annual_income <= bracket_max:
                return rate

        return brackets[-1][1] if brackets else 0.0

    if state in DEFAULT_STATE_RATES:
        return DEFAULT_STATE_RATES[state]

    return 0.05  # Default estimate


def get_all_states() -> list[dict]:
    """
    Get list of all states with their tax info.

    Returns:
        List of dicts with state code, name, and tax type
    """
    states = [
        {"code": "AL", "name": "Alabama", "type": "graduated"},
        {"code": "AK", "name": "Alaska", "type": "none"},
        {"code": "AZ", "name": "Arizona", "type": "flat"},
        {"code": "AR", "name": "Arkansas", "type": "graduated"},
        {"code": "CA", "name": "California", "type": "graduated"},
        {"code": "CO", "name": "Colorado", "type": "flat"},
        {"code": "CT", "name": "Connecticut", "type": "graduated"},
        {"code": "DE", "name": "Delaware", "type": "graduated"},
        {"code": "DC", "name": "District of Columbia", "type": "graduated"},
        {"code": "FL", "name": "Florida", "type": "none"},
        {"code": "GA", "name": "Georgia", "type": "graduated"},
        {"code": "HI", "name": "Hawaii", "type": "graduated"},
        {"code": "ID", "name": "Idaho", "type": "flat"},
        {"code": "IL", "name": "Illinois", "type": "flat"},
        {"code": "IN", "name": "Indiana", "type": "flat"},
        {"code": "IA", "name": "Iowa", "type": "graduated"},
        {"code": "KS", "name": "Kansas", "type": "graduated"},
        {"code": "KY", "name": "Kentucky", "type": "flat"},
        {"code": "LA", "name": "Louisiana", "type": "graduated"},
        {"code": "ME", "name": "Maine", "type": "graduated"},
        {"code": "MD", "name": "Maryland", "type": "graduated"},
        {"code": "MA", "name": "Massachusetts", "type": "flat"},
        {"code": "MI", "name": "Michigan", "type": "flat"},
        {"code": "MN", "name": "Minnesota", "type": "graduated"},
        {"code": "MS", "name": "Mississippi", "type": "graduated"},
        {"code": "MO", "name": "Missouri", "type": "graduated"},
        {"code": "MT", "name": "Montana", "type": "graduated"},
        {"code": "NE", "name": "Nebraska", "type": "graduated"},
        {"code": "NV", "name": "Nevada", "type": "none"},
        {"code": "NH", "name": "New Hampshire", "type": "none"},
        {"code": "NJ", "name": "New Jersey", "type": "graduated"},
        {"code": "NM", "name": "New Mexico", "type": "graduated"},
        {"code": "NY", "name": "New York", "type": "graduated"},
        {"code": "NC", "name": "North Carolina", "type": "flat"},
        {"code": "ND", "name": "North Dakota", "type": "graduated"},
        {"code": "OH", "name": "Ohio", "type": "graduated"},
        {"code": "OK", "name": "Oklahoma", "type": "graduated"},
        {"code": "OR", "name": "Oregon", "type": "graduated"},
        {"code": "PA", "name": "Pennsylvania", "type": "flat"},
        {"code": "RI", "name": "Rhode Island", "type": "graduated"},
        {"code": "SC", "name": "South Carolina", "type": "graduated"},
        {"code": "SD", "name": "South Dakota", "type": "none"},
        {"code": "TN", "name": "Tennessee", "type": "none"},
        {"code": "TX", "name": "Texas", "type": "none"},
        {"code": "UT", "name": "Utah", "type": "flat"},
        {"code": "VT", "name": "Vermont", "type": "graduated"},
        {"code": "VA", "name": "Virginia", "type": "graduated"},
        {"code": "WA", "name": "Washington", "type": "none"},
        {"code": "WV", "name": "West Virginia", "type": "graduated"},
        {"code": "WI", "name": "Wisconsin", "type": "graduated"},
        {"code": "WY", "name": "Wyoming", "type": "none"},
    ]
    return states
