"""Deterministic order validation; model text alone never authorizes fulfillment.

This module uses only the Python standard library. Geographic checks catch common
district/zone conflicts; they do not verify an address with an official registry.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any


CATALOG_PATH = Path(__file__).with_name("PRODUCT_CATALOG.md")
_BANGLA_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")
_PHONE_RE = re.compile(r"01[3-9][0-9]{8}\Z")
_ORDER_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_PRODUCT_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_EVENTS = {"ORDER_CONFIRMED", "ORDER_DRAFT"}
_ZONES = {"INSIDE_DHAKA", "DHAKA_SUBURBS", "OUTSIDE_DHAKA"}
_PARTNERS = {"STEADFAST", "PATHAO", "REDX"}
_CORE_FIELDS = {"order_event", "order_id", "customer", "items", "pricing_summary", "logistics"}
_INTEGRATION_FIELDS = {"courier_metadata", "messenger_psid", "messenger_last_interaction_at", "confirmation_message"}


class OrderValidationError(ValueError):
    """An order failed a business rule or its expected data shape."""


def _fail(message: str) -> None:
    raise OrderValidationError(message)


def _object(value: Any, label: str, required: set[str], optional: set[str] | None = None) -> dict:
    if not isinstance(value, dict):
        _fail(f"{label} must be an object")
    missing = required - value.keys()
    extras = value.keys() - required - (optional or set())
    if missing:
        _fail(f"{label} missing fields: {', '.join(sorted(missing))}")
    if extras:
        _fail(f"{label} has unsupported fields: {', '.join(sorted(str(key) for key in extras))}")
    return value


def _string(value: Any, label: str, maximum: int = 200, minimum: int = 1) -> str:
    if not isinstance(value, str):
        _fail(f"{label} must be a string")
    result = value.strip()
    if not minimum <= len(result) <= maximum or any(ord(char) < 32 for char in result):
        _fail(f"{label} must contain {minimum}-{maximum} printable characters")
    return result


def _integer(value: Any, label: str, minimum: int = 0, maximum: int | None = None) -> int:
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        suffix = f" through {maximum}" if maximum is not None else " or greater"
        _fail(f"{label} must be an integer {minimum}{suffix}")
    return value


def normalize_phone(value: str) -> str:
    """Normalize local/+880/880 BD numbers, including Bangla digits.

    Spaces, hyphens and parentheses are formatting; other characters are rejected.
    A phone must still be validated by the merchant/customer before dispatch.
    """
    if not isinstance(value, str):
        _fail("phone_number must be a string")
    phone = re.sub(r"[\s()\-]", "", value.translate(_BANGLA_DIGITS))
    if phone.startswith("+880"):
        phone = "0" + phone[4:]
    elif phone.startswith("880"):
        phone = "0" + phone[3:]
    if not _PHONE_RE.fullmatch(phone):
        _fail("phone_number must normalize to 11 digits starting with 013-019")
    return phone


def _money_cell(value: str, label: str) -> int:
    cleaned = value.translate(_BANGLA_DIGITS).strip().replace(",", "")
    cleaned = re.sub(r"(?i)\bBDT\b|৳", "", cleaned).strip()
    if not re.fullmatch(r"[0-9]+", cleaned):
        _fail(f"Catalog {label} must be an integer BDT amount")
    return int(cleaned)


def load_catalog(path: str | Path | None = None) -> dict[str, dict[str, Any]]:
    """Load the six-column merchant catalog table, rejecting ambiguous rows.

    Returned entries have item_name, product_id, regular_price_bdt,
    minimum_negotiable_price_bdt, stock_status, alternative_suggested_item.
    """
    catalog_path = Path(path) if path is not None else CATALOG_PATH
    try:
        markdown = catalog_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise OrderValidationError(f"Cannot read product catalog: {catalog_path.name}") from exc
    catalog: dict[str, dict[str, Any]] = {}
    in_table = False
    for line in markdown.splitlines():
        if not line.lstrip().startswith("|"):
            if in_table:
                break
            continue
        cells = [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]
        if len(cells) != 6:
            if in_table:
                _fail("Catalog table must have exactly six columns")
            continue
        if cells[0].casefold() == "item name" and cells[1].casefold() == "product id":
            in_table = True
            continue
        if not in_table or all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
            continue
        item_name, product_id, regular_raw, minimum_raw, stock_raw, alternative = cells
        if not _PRODUCT_ID_RE.fullmatch(product_id) or product_id in catalog:
            _fail("Catalog contains an invalid or duplicate Product ID")
        regular = _money_cell(regular_raw, product_id + " regular price")
        minimum = _money_cell(minimum_raw, product_id + " minimum price")
        if regular <= 0 or not 0 <= minimum <= regular:
            _fail("Catalog prices must have a positive regular price and a valid minimum")
        stock = re.sub(r"[\s-]+", "_", stock_raw.upper())
        if stock not in {"IN_STOCK", "OUT_OF_STOCK"}:
            _fail("Catalog stock status must be IN_STOCK or OUT_OF_STOCK")
        catalog[product_id] = {
            "item_name": _string(item_name, "Catalog item name"),
            "product_id": product_id,
            "regular_price_bdt": regular,
            "minimum_negotiable_price_bdt": minimum,
            "stock_status": stock,
            "alternative_suggested_item": alternative,
        }
    if not catalog:
        _fail("Catalog does not contain a product table")
    return catalog


def _location_key(value: str) -> str:
    return re.sub(r"[\s,._/\-]+", " ", value.casefold()).strip()


_DISTRICT_ALIASES = {
    "dhaka": "Dhaka", "ঢাকা": "Dhaka",
    "gazipur": "Gazipur", "গাজীপুর": "Gazipur", "গাজিপুর": "Gazipur",
    "narayanganj": "Narayanganj", "narayonganj": "Narayanganj",
    "নারায়ণগঞ্জ": "Narayanganj", "নারায়ণগঞ্জ": "Narayanganj", "নারায়নগঞ্জ": "Narayanganj",
    "ctg": "Chattogram", "chittagong": "Chattogram", "chattogram": "Chattogram",
    "চট্টগ্রাম": "Chattogram", "চট্রগ্রাম": "Chattogram",
    "jessore": "Jashore", "jashore": "Jashore", "যশোর": "Jashore",
    "sylhet": "Sylhet", "সিলেট": "Sylhet", "rajshahi": "Rajshahi", "রাজশাহী": "Rajshahi",
    "comilla": "Cumilla", "cumilla": "Cumilla", "কুমিল্লা": "Cumilla",
    "barisal": "Barishal", "barishal": "Barishal", "বরিশাল": "Barishal",
    "bogra": "Bogura", "bogura": "Bogura", "বগুড়া": "Bogura", "বগুড়া": "Bogura",
    "rangpur": "Rangpur", "রংপুর": "Rangpur", "khulna": "Khulna", "খুলনা": "Khulna",
}
_SUBURB_WORDS = {
    "savar", "সাভার", "ashulia", "আশুলিয়া", "আশুলিয়া",
    "gazipur", "গাজীপুর", "গাজিপুর", "tongi", "টঙ্গী", "টঙ্গি",
    "keraniganj", "keranigonj", "কেরানীগঞ্জ", "কেরানিগঞ্জ",
    "narayanganj", "narayonganj", "নারায়ণগঞ্জ", "নারায়ণগঞ্জ", "নারায়নগঞ্জ",
}
_OUTER_DHAKA_WORDS = {"dhamrai", "ধামরাই", "dohar", "দোহার", "nawabganj", "নবাবগঞ্জ"}
_DHAKA_CITY_WORDS = {
    "uttara", "উত্তরা", "gulshan", "গুলশান", "banani", "বনানী", "বনানি",
    "mirpur", "মিরপুর", "dhanmondi", "ধানমন্ডি", "ধানমণ্ডি",
    "mohammadpur", "mohammedpur", "মোহাম্মদপুর", "motijheel", "মতিঝিল",
    "ramna", "রমনা", "pallabi", "পল্লবী", "পল্লবি", "tejgaon", "তেজগাঁও",
    "badda", "বাড্ডা", "vatara", "ভাটারা", "bhatara", "rampura", "রামপুরা",
    "khilgaon", "খিলগাঁও", "khilkhet", "খিলক্ষেত", "lalbagh", "লালবাগ",
    "kotwali", "কোতোয়ালী", "কোতোয়ালী", "sutrapur", "সূত্রাপুর", "সুত্রাপুর",
    "wari", "ওয়ারী", "ওয়ারী", "ওয়ারি", "ওয়ারি", "jatrabari", "যাত্রাবাড়ী", "যাত্রাবাড়ী",
    "demra", "ডেমরা", "shyampur", "শ্যামপুর", "kadamtali", "কদমতলী",
    "hazaribagh", "hazaribag", "হাজারীবাগ", "হাজারিবাগ", "kalabagan", "কলাবাগান",
    "new market", "নিউ মার্কেট", "shahbag", "shahbagh", "শাহবাগ", "sher e bangla nagar",
    "sher ebangla nagar", "শেরে বাংলা নগর", "শেরেবাংলা নগর", "adabor", "আদাবর",
    "darussalam", "darus salam", "দারুস সালাম", "কাফরুল", "kafrul", "cantonment", "ক্যান্টনমেন্ট",
    "airport", "বিমানবন্দর", "bangshal", "বংশাল", "chawkbazar", "চকবাজার",
    "gendaria", "gandaria", "গেন্ডারিয়া", "গেন্ডারিয়া", "turag", "তুরাগ", "rupnagar", "রূপনগর",
    "paltan", "পল্টন", "sabujbagh", "সবুজবাগ",
}


def _has_location(value: str, words: set[str]) -> bool:
    key = _location_key(value)
    return any(re.search(r"(?<!\w)" + re.escape(word) + r"(?!\w)", key) for word in words)


def _validate_address(address: str, thana: str, district: str) -> None:
    """Require useful street/rural detail without demanding urban house numbers."""
    normalized = _location_key(address)
    location_only = {_location_key(district), _location_key(thana)}
    if normalized in location_only or len(normalized) < 10:
        _fail("address_line needs house/road/area or village details, not only a district/thana")
    detail_words = (
        r"\b(?:house|holding|flat|floor|road|rd|street|lane|block|sector|plot|village|vill|"
        r"union|ward|para|bazar|bazaar|market|post|p\s*o|near|beside|behind|opposite|"
        r"bari|basha|gram|elaka|moholla|mahal)\b|"
        r"বাড়ি|বাড়ি|বাসা|হোল্ডিং|ফ্ল্যাট|তলা|রোড|রাস্তা|সড়ক|সড়ক|লেন|ব্লক|সেক্টর|"
        r"গ্রাম|ইউনিয়ন|ইউনিয়ন|ওয়ার্ড|ওয়ার্ড|পাড়া|পাড়া|বাজার|ডাকঘর|পাশে|নিকট|মহল্লা"
    )
    usable_markers = 0
    placeholders = {"missing", "unknown", "none", "null", "not", "na", "tbd", "নেই", "অজানা"}
    rural_suffix_markers = {
        "village", "vill", "union", "ward", "para", "bazar", "bazaar", "gram",
        "গ্রাম", "ইউনিয়ন", "ইউনিয়ন", "ওয়ার্ড", "ওয়ার্ড", "পাড়া", "পাড়া", "বাজার",
    }
    marker_found = False
    # Keep component boundaries so a missing value cannot borrow the next
    # component's name. Rural names commonly precede their marker in Bangla.
    for raw_component in re.split(r"[,;।]", address):
        component = _location_key(raw_component)
        matches = list(re.finditer(detail_words, component, re.IGNORECASE))
        marker_found = marker_found or bool(matches)
        suffix_style = bool(matches and matches[0].group().casefold() in rural_suffix_markers and component[:matches[0].start()].strip())
        for index, match in enumerate(matches):
            if suffix_style and match.group().casefold() in rural_suffix_markers:
                start = matches[index - 1].end() if index else 0
                detail = component[start:match.start()].strip(" ,:;#-/")
            else:
                end = matches[index + 1].start() if index + 1 < len(matches) else len(component)
                detail = component[match.end():end].strip(" ,:;#-/")
            # A marker must name/number something; "House missing" is incomplete.
            if detail and detail.split()[0] not in placeholders and any(char.isalnum() for char in detail):
                usable_markers += 1
    if not marker_found:
        _fail("address_line needs a street/house marker or rural village/union/landmark detail")
    specific_thana_present = _location_key(thana) != _location_key(district) and _has_location(address, {_location_key(thana)})
    if usable_markers < 1 or (usable_markers < 2 and not specific_thana_present):
        _fail("address_line needs two useful address components, such as house + road or village + union/thana")


def _normalize_customer(value: Any) -> dict[str, Any]:
    fields = {"full_name", "phone_number", "address_line", "thana", "district", "zone"}
    customer = _object(value, "customer", fields, {"remote_area"})
    result: dict[str, Any] = {
        "full_name": _string(customer["full_name"], "full_name", 100),
        "phone_number": normalize_phone(customer["phone_number"]),
        "address_line": _string(customer["address_line"], "address_line", 500, 10),
        "thana": _string(customer["thana"], "thana", 100),
        "district": _string(customer["district"], "district", 100),
        "zone": _string(customer["zone"], "zone", 30),
    }
    result["district"] = _DISTRICT_ALIASES.get(_location_key(result["district"]), result["district"])
    if result["zone"] not in _ZONES:
        _fail("customer.zone is unsupported")
    if "remote_area" in customer:
        if type(customer["remote_area"]) is not bool:
            _fail("customer.remote_area must be a boolean verified upstream")
        result["remote_area"] = customer["remote_area"]
    _validate_address(result["address_line"], result["thana"], result["district"])
    district = result["district"]
    locality = result["thana"] + " " + result["address_line"]
    if district in {"Gazipur", "Narayanganj"}:
        expected = "DHAKA_SUBURBS"
    elif district == "Dhaka":
        if _has_location(locality, _SUBURB_WORDS):
            expected = "DHAKA_SUBURBS"
        elif _has_location(locality, _OUTER_DHAKA_WORDS):
            expected = "OUTSIDE_DHAKA"
        elif _has_location(locality, _DHAKA_CITY_WORDS):
            expected = "INSIDE_DHAKA"
        else:
            _fail("Dhaka locality is unrecognized; clarify the city thana/area before selecting a delivery zone")
    else:
        if _has_location(result["thana"], _SUBURB_WORDS):
            _fail("district conflicts with the supplied Dhaka suburb thana")
        expected = "OUTSIDE_DHAKA"
    if result["zone"] != expected:
        _fail(f"customer.zone conflicts with the address; expected {expected}")
    if result.get("remote_area") and expected != "OUTSIDE_DHAKA":
        _fail("remote_area applies only to OUTSIDE_DHAKA")
    return result


def _integration_fields(payload: dict) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if "courier_metadata" in payload:
        metadata = _object(payload["courier_metadata"], "courier_metadata", set(), {
            "recipient_city", "recipient_zone", "recipient_area", "item_weight_kg",
        })
        clean = {}
        for key in ("recipient_city", "recipient_zone", "recipient_area"):
            if key in metadata:
                clean[key] = _integer(metadata[key], "courier_metadata." + key, 1)
        if "item_weight_kg" in metadata:
            weight = metadata["item_weight_kg"]
            if type(weight) not in (int, float) or not math.isfinite(weight) or weight <= 0:
                _fail("courier_metadata.item_weight_kg must be a finite positive number")
            clean["item_weight_kg"] = weight
        result["courier_metadata"] = clean
    if "messenger_psid" in payload:
        psid = _string(payload["messenger_psid"], "messenger_psid", 64)
        if not re.fullmatch(r"[0-9]+", psid):
            _fail("messenger_psid must contain ASCII digits only")
        result["messenger_psid"] = psid
    if "messenger_last_interaction_at" in payload:
        timestamp = _string(payload["messenger_last_interaction_at"], "messenger_last_interaction_at", 64)
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError as exc:
            raise OrderValidationError("messenger_last_interaction_at must be an ISO8601 timestamp") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            _fail("messenger_last_interaction_at must include a timezone")
        result["messenger_last_interaction_at"] = timestamp
    if "confirmation_message" in payload:
        message = payload["confirmation_message"]
        if not isinstance(message, str) or not 1 <= len(message.strip()) <= 2000:
            _fail("confirmation_message must be a nonempty string up to 2000 characters")
        if any(ord(char) < 32 and char not in "\n\r\t" for char in message):
            _fail("confirmation_message has unsupported control characters")
        result["confirmation_message"] = message.strip()
    return result


def validate_order(payload: Any, allow_draft: bool = False) -> dict[str, Any]:
    """Return a canonical order or raise OrderValidationError.

    Integration fields are accepted for trusted callers. Never accept merchant
    routing metadata, Messenger identity, or timestamps directly from model text.
    """
    payload = _object(payload, "order", _CORE_FIELDS, _INTEGRATION_FIELDS)
    event = payload["order_event"]
    permitted = _EVENTS if allow_draft else {"ORDER_CONFIRMED"}
    if not isinstance(event, str) or event not in permitted:
        _fail("order_event must be ORDER_CONFIRMED" + (" or ORDER_DRAFT" if allow_draft else ""))
    order_id = _string(payload["order_id"], "order_id", 64)
    if not _ORDER_ID_RE.fullmatch(order_id):
        _fail("order_id must use only letters, digits, underscore, dot, or hyphen and start alphanumeric")
    customer = _normalize_customer(payload["customer"])
    catalog = load_catalog()
    items = payload["items"]
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        _fail("items must contain 1-100 products")
    canonical_items = []
    seen = set()
    subtotal = 0
    minimum_total = 0
    for index, value in enumerate(items):
        item = _object(value, f"items[{index}]", {"product_id", "quantity", "unit_price_bdt"})
        product_id = _string(item["product_id"], f"items[{index}].product_id", 64)
        if product_id in seen:
            _fail("Duplicate product IDs must be combined into one item")
        seen.add(product_id)
        product = catalog.get(product_id)
        if product is None or product["stock_status"] != "IN_STOCK":
            _fail(f"Product {product_id} is unknown or out of stock")
        quantity = _integer(item["quantity"], f"items[{index}].quantity", 1, 100)
        price = _integer(item["unit_price_bdt"], f"items[{index}].unit_price_bdt", 1)
        if price != product["regular_price_bdt"]:
            _fail("unit_price_bdt must match the catalog regular price; use discount_applied_bdt separately")
        subtotal += price * quantity
        minimum_total += product["minimum_negotiable_price_bdt"] * quantity
        canonical_items.append({"product_id": product_id, "quantity": quantity, "unit_price_bdt": price})
    pricing_fields = {"subtotal_bdt", "discount_applied_bdt", "delivery_charge_bdt", "grand_total_bdt"}
    raw_pricing = _object(payload["pricing_summary"], "pricing_summary", pricing_fields)
    pricing = {key: _integer(raw_pricing[key], "pricing_summary." + key) for key in pricing_fields}
    if pricing["subtotal_bdt"] != subtotal:
        _fail("subtotal_bdt does not match catalog prices and quantities")
    discount = pricing["discount_applied_bdt"]
    if discount > subtotal // 10 or subtotal - discount < minimum_total:
        _fail("Discount exceeds the 10% maximum or the catalog minimum negotiable price")
    # One order-wide discount is allocated proportionally across all products.
    # Cross multiplication protects each unit floor without floating-point math.
    for item in canonical_items:
        product = catalog[item["product_id"]]
        if item["unit_price_bdt"] * (subtotal - discount) < product["minimum_negotiable_price_bdt"] * subtotal:
            _fail("Proportional order discount falls below a product's minimum negotiable price")
    delivery = pricing["delivery_charge_bdt"]
    if delivery == 0:
        if discount != 0:
            _fail("Free delivery cannot be combined with a product discount")
    else:
        zone = customer["zone"]
        expected_charge = 70 if zone == "INSIDE_DHAKA" else 100 if zone == "DHAKA_SUBURBS" else 150 if customer.get("remote_area") else 130
        if delivery != expected_charge:
            _fail(f"delivery_charge_bdt must be {expected_charge} for this zone (or 0 without a product discount)")
    if pricing["grand_total_bdt"] != subtotal - discount + delivery:
        _fail("grand_total_bdt must equal subtotal minus discount plus delivery")
    logistics = _object(payload["logistics"], "logistics", {"courier_partner", "payment_method"})
    partner = logistics["courier_partner"]
    if not isinstance(partner, str) or partner not in _PARTNERS:
        _fail("courier_partner must be STEADFAST, PATHAO, or REDX")
    if logistics["payment_method"] != "CASH_ON_DELIVERY":
        _fail("payment_method must be CASH_ON_DELIVERY")
    return {
        "order_event": event,
        "order_id": order_id,
        "customer": customer,
        "items": canonical_items,
        "pricing_summary": pricing,
        "logistics": {"courier_partner": partner, "payment_method": "CASH_ON_DELIVERY"},
        **_integration_fields(payload),
    }


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON property")
        result[key] = value
    return result


def _invalid_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def extract_order(text: str) -> dict[str, Any] | None:
    """Extract only a valid final fenced order object; this does not validate it."""
    if not isinstance(text, str):
        return None
    pattern = r"(?:^|\n)```json[ \t]*\r?\n(?P<payload>(?:(?!\r?\n```)[\s\S])*)\r?\n```[ \t]*\s*\Z"
    match = re.search(pattern, text)
    if match is None:
        return None
    try:
        payload = json.loads(match.group("payload"), object_pairs_hook=_no_duplicate_keys, parse_constant=_invalid_constant)
    except (ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("order_event"), str) or payload["order_event"] not in _EVENTS:
        return None
    return payload


def confirmation_fingerprint(order: dict[str, Any]) -> str:
    """Hash the canonical core order, ignoring draft/final event and integrations.

    Validate first. The same order ID and review details must be used at confirm.
    """
    core = {key: order[key] for key in _CORE_FIELDS if key != "order_event"}
    encoded = json.dumps(core, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
