"""Small, explicitly configured courier, Sheets and Messenger API adapters.

Only call these adapters after validating and durably reserving an order. They
never infer courier route IDs, customer PSIDs, weights or credentials.
"""

from datetime import datetime, timezone
import json
import math
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


class IntegrationError(Exception):
    """A safe error code, with uncertainty about whether a mutation happened."""

    def __init__(self, code, *, ambiguous=False):
        self.code = code
        self.ambiguous = ambiguous
        super().__init__(code)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Do not forward bearer/API credentials to a redirected host.
        return None


def _required(config, name):
    value = config.get(name)
    if value is None or value == "":
        raise IntegrationError("missing_" + name.lower())
    return value


def _https_url(value):
    parsed = urlparse(str(value))
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise IntegrationError("invalid_https_endpoint")
    return str(value).rstrip("/")


def _positive_int(value, code):
    if isinstance(value, bool):
        raise IntegrationError(code)
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise IntegrationError(code) from None
    if number <= 0 or str(number) != str(value):
        raise IntegrationError(code)
    return number


def _post_json(url, payload, headers=None, *, timeout=15, mutation=True):
    """No automatic POST retries. Never surface bodies that may contain PII."""
    request = Request(
        _https_url(url),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Accept": "application/json", "Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with build_opener(_NoRedirect()).open(request, timeout=float(timeout)) as response:
            body = response.read(1_048_577)
            if len(body) > 1_048_576:
                raise IntegrationError("response_too_large", ambiguous=mutation)
            try:
                decoded = json.loads(body.decode("utf-8"))
            except (UnicodeError, ValueError):
                raise IntegrationError("invalid_response", ambiguous=mutation) from None
            if not isinstance(decoded, dict):
                raise IntegrationError("invalid_response", ambiguous=mutation)
            return decoded
    except HTTPError as error:
        # A server error can arrive after a successful create/append/send.
        raise IntegrationError("http_" + str(error.code), ambiguous=mutation and (error.code == 408 or error.code >= 500 or 300 <= error.code < 400)) from None
    except (URLError, TimeoutError, socket.timeout, OSError):
        raise IntegrationError("transport_error", ambiguous=mutation) from None


def deliver_courier(order, config):
    partner = order["logistics"]["courier_partner"]
    customer = order["customer"]
    address = ", ".join((customer["address_line"], customer["thana"], customer["district"]))
    amount = order["pricing_summary"]["grand_total_bdt"]
    timeout = config.get("API_TIMEOUT_SECONDS", 15)
    if partner == "STEADFAST":
        result = _post_json(
            _https_url(config.get("STEADFAST_BASE_URL", "https://portal.steadfast.com.bd/api/v1")) + "/create_order",
            {
                "invoice": order["order_id"],
                "recipient_name": customer["full_name"],
                "recipient_phone": customer["phone_number"],
                "recipient_address": address,
                "cod_amount": amount,
                "note": "Cash on delivery. Merchant order " + order["order_id"],
            },
            {"Api-Key": _required(config, "STEADFAST_API_KEY"), "Secret-Key": _required(config, "STEADFAST_SECRET_KEY")},
            timeout=timeout,
        )
        consignment = result.get("consignment") or {}
        if result.get("status") != 200 or not isinstance(consignment, dict) or not consignment.get("consignment_id"):
            raise IntegrationError("courier_response_unverified", ambiguous=True)
        return {"courier_partner": partner, "consignment_id": str(consignment["consignment_id"]), "tracking_code": str(consignment.get("tracking_code") or ""), "tracking_available": bool(consignment.get("tracking_code"))}
    if partner == "PATHAO":
        base = _https_url(config.get("PATHAO_BASE_URL", "https://api-hermes.pathao.com"))
        metadata = order.get("courier_metadata", {})
        # Validate all merchant routing configuration BEFORE obtaining a token.
        store_id = _positive_int(_required(config, "PATHAO_STORE_ID"), "invalid_pathao_store_id")
        route = {}
        for key, env_name in (("recipient_city", "PATHAO_CITY_ID"), ("recipient_zone", "PATHAO_ZONE_ID"), ("recipient_area", "PATHAO_AREA_ID")):
            route[key] = _positive_int(metadata.get(key, config.get(env_name)), "missing_or_invalid_" + key)
        weight = metadata.get("item_weight_kg", config.get("PATHAO_ITEM_WEIGHT_KG"))
        try:
            if isinstance(weight, bool):
                raise ValueError
            weight = float(weight)
            if not math.isfinite(weight) or weight <= 0:
                raise ValueError
        except (TypeError, ValueError):
            raise IntegrationError("missing_or_invalid_item_weight") from None
        login = _post_json(
            base + "/aladdin/api/v1/external/login",
            {"client_id": _required(config, "PATHAO_CLIENT_ID"), "client_secret": _required(config, "PATHAO_CLIENT_SECRET")},
            timeout=timeout,
            mutation=False,
        )
        token = login.get("access_token")
        if not isinstance(token, str) or not token:
            raise IntegrationError("pathao_auth_response_unverified")
        result = _post_json(
            base + "/aladdin/api/v1/orders",
            {
                "store_id": store_id,
                "merchant_order_id": order["order_id"],
                "recipient_name": customer["full_name"],
                "recipient_phone": customer["phone_number"],
                "recipient_address": address,
                **route,
                "delivery_type": 48,
                "item_type": 2,
                "item_quantity": sum(item["quantity"] for item in order["items"]),
                "item_weight": weight,
                "amount_to_collect": amount,
                "item_description": ", ".join(item["product_id"] for item in order["items"]),
                "special_instruction": "Cash on delivery",
            },
            {"Authorization": "Bearer " + token},
            timeout=timeout,
        )
        data = result.get("data") or {}
        if not isinstance(data, dict) or not data.get("consignment_id"):
            raise IntegrationError("courier_response_unverified", ambiguous=True)
        return {"courier_partner": partner, "consignment_id": str(data["consignment_id"]), "tracking_code": str(data["consignment_id"])}
    raise IntegrationError("unsupported_courier")


def append_sheet(order, config):
    customer = order["customer"]
    row = {
        "full_name": customer["full_name"],
        "phone_number": customer["phone_number"],
        "address_line": customer["address_line"],
        "district": customer["district"],
        "grand_total_bdt": order["pricing_summary"]["grand_total_bdt"],
    }
    if config.get("SHEETS_WEBHOOK_URL"):
        _post_json(config["SHEETS_WEBHOOK_URL"], {"order_event": "ORDER_CONFIRMED", "order_id": order["order_id"], **row}, timeout=config.get("API_TIMEOUT_SECONDS", 15))
        # A Catch Hook acknowledgement is not proof that a Sheet row exists.
        return {"delivery": "forwarded_to_automation", "row_saved": False}
    spreadsheet = _required(config, "GOOGLE_SHEETS_SPREADSHEET_ID")
    if config.get("GOOGLE_SHEETS_SERVICE_ACCOUNT_FILE"):
        try:
            from google.auth.exceptions import GoogleAuthError
            from google.auth.transport.requests import Request as GoogleAuthRequest
            from google.oauth2.service_account import Credentials
        except ImportError:
            raise IntegrationError("missing_google_auth_dependency") from None
        try:
            credentials = Credentials.from_service_account_file(
                config["GOOGLE_SHEETS_SERVICE_ACCOUNT_FILE"],
                scopes=["https://www.googleapis.com/auth/spreadsheets"],
            )
            credentials.refresh(GoogleAuthRequest())
            token = credentials.token
            if not token:
                raise ValueError
        except (GoogleAuthError, OSError, ValueError):
            raise IntegrationError("google_service_account_auth_failed") from None
    else:
        token = _required(config, "GOOGLE_SHEETS_ACCESS_TOKEN")
    sheet_range = config.get("GOOGLE_SHEETS_RANGE", "Orders!A:E")
    url = "https://sheets.googleapis.com/v4/spreadsheets/" + quote(str(spreadsheet), safe="") + "/values/" + quote(str(sheet_range), safe="") + ":append?" + urlencode({"valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"})
    result = _post_json(url, {"majorDimension": "ROWS", "values": [list(row.values())]}, {"Authorization": "Bearer " + token}, timeout=config.get("API_TIMEOUT_SECONDS", 15))
    updates = result.get("updates")
    if not isinstance(updates, dict) or updates.get("updatedRows") != 1:
        raise IntegrationError("sheet_response_unverified", ambiguous=True)
    return {"delivery": "sheet_row_appended", "row_saved": True}


def messenger_eligibility(order, now=None):
    if not order.get("messenger_psid"):
        return "missing_messenger_psid"
    value = order.get("messenger_last_interaction_at")
    if not value:
        return "missing_messenger_interaction_time"
    try:
        last_interaction = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if last_interaction.tzinfo is None:
            raise ValueError
    except (TypeError, ValueError):
        return "invalid_messenger_interaction_time"
    age = ((now or datetime.now(timezone.utc)) - last_interaction).total_seconds()
    if age < 0 or age > 24 * 60 * 60:
        return "outside_messenger_response_window"
    return None


def _send_messenger(order, text, config):
    reason = messenger_eligibility(order)
    if reason:
        return {"skipped": reason}
    version = str(_required(config, "META_GRAPH_VERSION"))
    page_id = str(_required(config, "META_PAGE_ID"))
    if not version.startswith("v") or not version[1:].replace(".", "").isdigit() or not page_id.isdigit():
        raise IntegrationError("invalid_meta_configuration")
    result = _post_json(
        "https://graph.facebook.com/" + version + "/" + page_id + "/messages",
        {"recipient": {"id": order["messenger_psid"]}, "messaging_type": "RESPONSE", "message": {"text": text}},
        {"Authorization": "Bearer " + str(_required(config, "META_PAGE_ACCESS_TOKEN"))},
        timeout=config.get("API_TIMEOUT_SECONDS", 15),
    )
    if not result.get("message_id") or str(result.get("recipient_id", "")) != str(order["messenger_psid"]):
        raise IntegrationError("messenger_response_unverified", ambiguous=True)
    return {"delivery": "messenger_message_sent", "message_id": str(result["message_id"])}


def send_confirmation(order, config):
    # Received does not claim courier dispatch, SMS delivery, or a delivery date.
    text = order.get("confirmation_message") or "Thank you! Order " + order["order_id"] + " is confirmed. Cash on delivery total: BDT " + str(order["pricing_summary"]["grand_total_bdt"]) + ". Tracking will be shared when available."
    return _send_messenger(order, text, config)


def send_tracking(order, tracking_code, status, config):
    return _send_messenger(order, "Order " + order["order_id"] + ": " + status + ". Courier tracking code: " + tracking_code + ".", config)
