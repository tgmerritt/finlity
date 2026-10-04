"""Built-in keyword to category rules for common merchants (design 4.5, 6.1).

A seed matches when the merchant key starts with its keyword and the next
character is not a letter or digit. Category names map to the user's category
ids by exact name; a renamed or deleted category means no seed match. Only
generic, well-known merchants belong here; keep short keywords out, because a
surname-like keyword would categorize payments to people.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .types import CATEGORIZABLE_KINDS

_GROCERY = "Food & Dining"
_DINING = "Food & Dining"
_FUEL = "Transportation"

SEED_RULES: tuple[tuple[str, str], ...] = (
    # Groceries
    ("SAFEWAY", _GROCERY),
    ("KROGER", _GROCERY),
    ("WHOLE FOODS", _GROCERY),
    ("TRADER JOE", _GROCERY),
    ("TRADER JOES", _GROCERY),
    ("COSTCO WHSE", _GROCERY),
    ("ALBERTSONS", _GROCERY),
    ("PUBLIX", _GROCERY),
    ("WEGMANS", _GROCERY),
    ("ALDI", _GROCERY),
    ("HEB", _GROCERY),
    ("H E B", _GROCERY),
    ("MEIJER", _GROCERY),
    ("FOOD LION", _GROCERY),
    ("GIANT EAGLE", _GROCERY),
    ("STOP & SHOP", _GROCERY),
    ("SPROUTS FARMERS", _GROCERY),
    ("WINCO FOODS", _GROCERY),
    ("KING SOOPERS", _GROCERY),
    ("RALPHS", _GROCERY),
    ("VONS", _GROCERY),
    ("FRED MEYER", _GROCERY),
    ("HARRIS TEETER", _GROCERY),
    ("INSTACART", _GROCERY),
    ("SAVE MART", _GROCERY),
    # Restaurants and coffee
    ("STARBUCKS", _DINING),
    ("MCDONALD", _DINING),
    ("MCDONALDS", _DINING),
    ("CHIPOTLE", _DINING),
    ("SUBWAY", _DINING),
    ("DUNKIN", _DINING),
    ("DOMINOS", _DINING),
    ("PIZZA HUT", _DINING),
    ("TACO BELL", _DINING),
    ("WENDYS", _DINING),
    ("BURGER KING", _DINING),
    ("CHICK FIL A", _DINING),
    ("PANERA", _DINING),
    ("PANDA EXPRESS", _DINING),
    ("OLIVE GARDEN", _DINING),
    ("APPLEBEES", _DINING),
    ("CHILIS", _DINING),
    ("DENNYS", _DINING),
    ("IHOP", _DINING),
    ("DOORDASH", _DINING),
    ("UBER EATS", _DINING),
    ("GRUBHUB", _DINING),
    ("POSTMATES", _DINING),
    ("PEETS", _DINING),
    ("BLUE BOTTLE COFFEE", _DINING),
    ("SONIC DRIVE", _DINING),
    ("ARBYS", _DINING),
    ("POPEYES", _DINING),
    ("KFC", _DINING),
    ("FIVE GUYS", _DINING),
    ("SHAKE SHACK", _DINING),
    ("JIMMY JOHNS", _DINING),
    ("JACK IN THE BOX", _DINING),
    ("IN N OUT", _DINING),
    ("WHATABURGER", _DINING),
    ("CHEESECAKE FACTORY", _DINING),
    # Fuel and transportation
    ("SHELL", _FUEL),
    ("CHEVRON", _FUEL),
    ("EXXON", _FUEL),
    ("EXXONMOBIL", _FUEL),
    ("MOBIL", _FUEL),
    ("BP PRODUCTS", _FUEL),
    ("BP GAS", _FUEL),
    ("ARCO", _FUEL),
    ("VALERO", _FUEL),
    ("SUNOCO", _FUEL),
    ("CITGO", _FUEL),
    ("MARATHON PETRO", _FUEL),
    ("SPEEDWAY", _FUEL),
    ("CIRCLE K", _FUEL),
    ("WAWA", _FUEL),
    ("SHEETZ", _FUEL),
    ("CASEYS", _FUEL),
    ("PILOT TRAVEL", _FUEL),
    ("UBER TRIP", _FUEL),
    ("UBER", _FUEL),
    ("LYFT", _FUEL),
    ("AMTRAK", _FUEL),
    ("GREYHOUND", _FUEL),
    ("PARKMOBILE", _FUEL),
    ("EZPASS", _FUEL),
    ("FASTRAK", _FUEL),
    ("SUNPASS", _FUEL),
    ("JIFFY LUBE", _FUEL),
    ("AUTOZONE", _FUEL),
    ("OREILLY AUTO", _FUEL),
    ("ADVANCE AUTO", _FUEL),
    ("PEP BOYS", _FUEL),
    ("DELTA AIR", _FUEL),
    ("UNITED AIRLINES", _FUEL),
    ("AMERICAN AIRLINES", _FUEL),
    ("SOUTHWEST AIR", _FUEL),
    ("JETBLUE", _FUEL),
    ("ALASKA AIR", _FUEL),
    ("SPIRIT AIRLINES", _FUEL),
    ("FRONTIER AIR", _FUEL),
    ("HERTZ", _FUEL),
    ("AVIS", _FUEL),
    ("ENTERPRISE RENT", _FUEL),
    ("BUDGET RENT", _FUEL),
    ("MARRIOTT", "Entertainment"),
    ("HILTON HOTELS", "Entertainment"),
    ("HYATT", "Entertainment"),
    ("AIRBNB", "Entertainment"),
    ("EXPEDIA", "Entertainment"),
    ("BOOKING.COM", "Entertainment"),
    ("VRBO", "Entertainment"),
    # Streaming and entertainment
    ("NETFLIX", "Entertainment"),
    ("HULU", "Entertainment"),
    ("SPOTIFY", "Entertainment"),
    ("DISNEY PLUS", "Entertainment"),
    ("DISNEYPLUS", "Entertainment"),
    ("HBO MAX", "Entertainment"),
    ("MAX.COM", "Entertainment"),
    ("PEACOCK", "Entertainment"),
    ("PARAMOUNT", "Entertainment"),
    ("APPLE TV", "Entertainment"),
    ("AMAZON PRIME VIDEO", "Entertainment"),
    ("YOUTUBE", "Entertainment"),
    ("YOUTUBEPREMIUM", "Entertainment"),
    ("TWITCH", "Entertainment"),
    ("STEAM GAMES", "Entertainment"),
    ("STEAMPOWERED", "Entertainment"),
    ("PLAYSTATION", "Entertainment"),
    ("XBOX", "Entertainment"),
    ("NINTENDO", "Entertainment"),
    ("AMC THEATRES", "Entertainment"),
    ("REGAL CINEMAS", "Entertainment"),
    ("CINEMARK", "Entertainment"),
    ("TICKETMASTER", "Entertainment"),
    ("STUBHUB", "Entertainment"),
    ("AUDIBLE", "Entertainment"),
    ("KINDLE", "Entertainment"),
    ("PANDORA", "Entertainment"),
    ("SIRIUSXM", "Entertainment"),
    ("SIRIUS XM", "Entertainment"),
    ("DROPBOX", "Other"),
    ("ICLOUD", "Other"),
    ("GOOGLE STORAGE", "Other"),
    ("MICROSOFT 365", "Other"),
    # Utilities and telecom
    ("VERIZON", "Utilities"),
    ("AT&T", "Utilities"),
    ("T MOBILE", "Utilities"),
    ("TMOBILE", "Utilities"),
    ("SPRINT", "Utilities"),
    ("COMCAST", "Utilities"),
    ("XFINITY", "Utilities"),
    ("SPECTRUM", "Utilities"),
    ("COX COMMUNICATIONS", "Utilities"),
    ("FRONTIER COMM", "Utilities"),
    ("CENTURYLINK", "Utilities"),
    ("GOOGLE FIBER", "Utilities"),
    ("MINT MOBILE", "Utilities"),
    ("CRICKET WIRELESS", "Utilities"),
    ("PG&E", "Utilities"),
    ("CON EDISON", "Utilities"),
    ("DUKE ENERGY", "Utilities"),
    ("PEPCO", "Utilities"),
    ("DOMINION ENERGY", "Utilities"),
    ("SOUTHERN CALIFORNIA EDISON", "Utilities"),
    ("NATIONAL GRID", "Utilities"),
    ("WATER DEPT", "Utilities"),
    ("WATER BUREAU", "Utilities"),
    ("WASTE MANAGEMENT", "Utilities"),
    ("REPUBLIC SERVICES", "Utilities"),
    # Housing
    ("HOME DEPOT", "Housing"),
    ("LOWES", "Housing"),
    ("ACE HARDWARE", "Housing"),
    ("MENARDS", "Housing"),
    ("IKEA", "Housing"),
    ("RENT PAYMENT", "Housing"),
    ("MORTGAGE", "Housing"),
    ("HOA DUES", "Housing"),
    ("APARTMENTS", "Housing"),
    ("ZILLOW RENTAL", "Housing"),
    # Insurance
    ("GEICO", "Insurance"),
    ("PROGRESSIVE", "Insurance"),
    ("STATE FARM", "Insurance"),
    ("ALLSTATE", "Insurance"),
    ("LIBERTY MUTUAL", "Insurance"),
    ("FARMERS INS", "Insurance"),
    ("NATIONWIDE", "Insurance"),
    ("USAA INS", "Insurance"),
    ("LEMONADE", "Insurance"),
    ("METLIFE", "Insurance"),
    ("PRUDENTIAL", "Insurance"),
    # Healthcare
    ("CVS", "Healthcare"),
    ("WALGREENS", "Healthcare"),
    ("RITE AID", "Healthcare"),
    ("KAISER", "Healthcare"),
    ("LABCORP", "Healthcare"),
    ("QUEST DIAGNOSTICS", "Healthcare"),
    ("DELTA DENTAL", "Healthcare"),
    ("EXPRESS SCRIPTS", "Healthcare"),
    ("ONE MEDICAL", "Healthcare"),
    ("GOODRX", "Healthcare"),
    ("CLINIC", "Healthcare"),
    ("DENTAL", "Healthcare"),
    ("PHARMACY", "Healthcare"),
    ("URGENT CARE", "Healthcare"),
    # Shopping, personal
    ("AMAZON", "Personal"),
    ("AMZN", "Personal"),
    ("TARGET.COM", "Personal"),
    ("TARGET STORE", "Personal"),
    ("WALMART", "Personal"),
    ("WM SUPERCENTER", "Personal"),
    ("COSTCO", "Personal"),
    ("BEST BUY", "Personal"),
    ("APPLE.COM", "Personal"),
    ("NIKE", "Personal"),
    ("OLD NAVY", "Personal"),
    ("GAP OUTLET", "Personal"),
    ("MACYS", "Personal"),
    ("KOHLS", "Personal"),
    ("NORDSTROM", "Personal"),
    ("TJ MAXX", "Personal"),
    ("TJMAXX", "Personal"),
    ("MARSHALLS", "Personal"),
    ("ROSS STORES", "Personal"),
    ("ETSY", "Personal"),
    ("EBAY", "Personal"),
    ("WAYFAIR", "Personal"),
    ("CHEWY", "Personal"),
    ("PETCO", "Personal"),
    ("PETSMART", "Personal"),
    ("ULTA", "Personal"),
    ("SEPHORA", "Personal"),
    ("GREAT CLIPS", "Personal"),
    ("PLANET FITNESS", "Personal"),
    ("LA FITNESS", "Personal"),
    ("PELOTON", "Personal"),
    ("DOLLAR TREE", "Personal"),
    ("DOLLAR GENERAL", "Personal"),
    # Education
    ("COURSERA", "Education"),
    ("UDEMY", "Education"),
    ("DUOLINGO", "Education"),
    ("MASTERCLASS", "Education"),
    ("NAVIENT", "Debt Payments"),
    ("NELNET", "Debt Payments"),
    ("SALLIE MAE", "Debt Payments"),
    ("UNIVERSITY OF", "Education"),
    ("COLLEGE BOARD", "Education"),
    # Savings and investing
    ("VANGUARD", "Savings & Investments"),
    ("FIDELITY INVEST", "Savings & Investments"),
    ("SCHWAB", "Savings & Investments"),
    ("ROBINHOOD", "Savings & Investments"),
    ("ACORNS", "Savings & Investments"),
    ("BETTERMENT", "Savings & Investments"),
    ("WEALTHFRONT", "Savings & Investments"),
    ("COINBASE", "Savings & Investments"),
)


def _by_length() -> tuple[tuple[str, str], ...]:
    """Longest keyword first, so a specific rule beats a general one."""
    return tuple(sorted(SEED_RULES, key=lambda kv: (-len(kv[0]), kv[0])))


_ORDERED_SEEDS = _by_length()


def seed_category_name(key: str) -> str | None:
    """Return the seed category name for a merchant key, or None."""
    for keyword, name in _ORDERED_SEEDS:
        if key.startswith(keyword):
            rest = key[len(keyword) : len(keyword) + 1]
            if not rest or not rest.isalnum():
                return name
    return None


def _user_rule_index(
    user_rules: Mapping[str, Any] | Iterable[Mapping[str, Any]] | None,
) -> dict[str, Mapping[str, Any]]:
    """Accept {merchant_key: rule} or a list of rule rows with a merchant_key."""
    if not user_rules:
        return {}
    if isinstance(user_rules, Mapping):
        return {str(k): v for k, v in user_rules.items() if isinstance(v, Mapping)}
    return {str(r["merchant_key"]): r for r in user_rules if "merchant_key" in r}


def apply_rules(
    transactions: Iterable[dict[str, Any]],
    user_rules: Mapping[str, Any] | Iterable[Mapping[str, Any]] | None,
    categories: Iterable[Mapping[str, Any]],
) -> None:
    """Set category_id, category_source and a rule's kind on each transaction.

    Order (design 6.1): the user rule with the exact merchant key, then the
    seed prefix rules. A rule's ``kind`` (when set) replaces the row's kind.
    Rows whose final kind is not expense, fee, interest or refund get no
    category. A user rule whose category is not in ``categories`` is ignored.
    ``categories`` is a list of ``{"id", "name"}``; user rules are
    ``{merchant_key: {"category_id", "kind"?}}`` or a list of such rows.
    """
    cats = list(categories)
    valid_ids = {str(c["id"]) for c in cats}
    id_by_name = {str(c["name"]): str(c["id"]) for c in cats}
    rules = _user_rule_index(user_rules)

    for tx in transactions:
        key = tx["merchant_key"]
        rule = rules.get(key)
        if rule is not None and rule.get("kind"):
            tx["kind"] = rule["kind"]

        tx["category_id"] = None
        tx["category_source"] = "none"
        if tx["kind"] not in CATEGORIZABLE_KINDS:
            continue

        if rule is not None and rule.get("category_id") is not None:
            if str(rule["category_id"]) in valid_ids:
                tx["category_id"] = str(rule["category_id"])
                tx["category_source"] = "rule"
                continue
        name = seed_category_name(key)
        if name is not None and name in id_by_name:
            tx["category_id"] = id_by_name[name]
            tx["category_source"] = "seed"
