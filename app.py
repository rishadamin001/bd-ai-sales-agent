"""Aura's Gemini chat bridge. Run `python app.py` for an interactive session."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib import error, request
from urllib.parse import urlparse

from orders import OrderValidationError, confirmation_fingerprint, extract_order, validate_order

ROOT = Path(__file__).resolve().parent
TRUSTED_INTEGRATION_FIELDS = {
    "courier_metadata", "messenger_psid", "messenger_last_interaction_at", "confirmation_message"
}


def load_env(path: Path = ROOT / ".env") -> None:
    """Load simple KEY=value settings without shell expansion or overwriting env."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name.strip()):
            raise ValueError("Invalid .env entry; use KEY=value without shell commands.")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(name.strip(), value)


def system_instructions(order_id: str) -> str:
    documents = []
    for filename in ("SYSTEM_PROMPT.md", "DELIVERY_RATES.md", "PRODUCT_CATALOG.md"):
        documents.append(f"\n\n# Merchant document: {filename}\n{(ROOT / filename).read_text(encoding='utf-8')}")
    documents.append(
        f"\n\n# Application session\nUse order_id {order_id} for this session. "
        "Do not emit courier_metadata, messenger_psid, messenger_last_interaction_at, or "
        "confirmation_message. These are provided only by the merchant's trusted integration. "
        "After showing ORDER_DRAFT ask the shopper to reply 'confirm', 'yes confirm', "
        "'ha confirm koren', or 'কনফার্ম করুন'. One order per session."
    )
    return "".join(documents)


def explicit_confirmation(message: str) -> bool:
    """Only unambiguous, whole-message confirmations approve a pending quote."""
    text = re.sub(r"[.!?,।]+$", "", message.strip().casefold()).strip()
    return text in {
        "confirm", "confirmed", "yes", "yes confirm", "yes please confirm", "yes please",
        "confirm my order", "place my order", "ha", "haa", "ha confirm koren",
        "ha confirm korun", "order kore den", "order confirm koren", "ji confirm koren",
        "হ্যাঁ", "জি", "হ্যাঁ কনফার্ম করুন", "কনফার্ম করুন", "অর্ডার কনফার্ম করুন",
        "অর্ডার করে দিন",
    }


@dataclass
class OrderState:
    order_id: str
    pending: dict | None = None
    confirmed: bool = False


def breakdown(order: dict) -> str:
    price = order["pricing_summary"]
    return (
        f"Subtotal ৳{price['subtotal_bdt']} - discount ৳{price['discount_applied_bdt']} "
        f"+ delivery ৳{price['delivery_charge_bdt']} = COD total ৳{price['grand_total_bdt']}"
    )


def process_response(text: str, user_message: str, state: OrderState) -> tuple[str, dict | None]:
    """Gate model events against validated inventory and the previous quote."""
    payload = extract_order(text)
    if payload is None:
        if "ORDER_CONFIRMED" in text or "ORDER_DRAFT" in text:
            raise OrderValidationError("The order JSON is malformed. No order was dispatched.")
        # Any message other than simple assent may amend the customer's requirements.
        if not explicit_confirmation(user_message):
            state.pending = None
        return text, None
    if TRUSTED_INTEGRATION_FIELDS & payload.keys():
        state.pending = None
        raise OrderValidationError("The model supplied merchant-only integration settings.")
    if isinstance(payload.get("customer"), dict) and "remote_area" in payload["customer"]:
        state.pending = None
        raise OrderValidationError("Remote-area status must be verified by the merchant, not the model.")
    order = validate_order(payload, allow_draft=True)
    if order["order_id"] != state.order_id:
        state.pending = None
        raise OrderValidationError("Order ID does not match this chat session.")
    if state.confirmed:
        return "This order has already been captured. Use /new for another order.", None
    if order["order_event"] == "ORDER_DRAFT":
        state.pending = order
        return f"{text}\n\nVerified quote: {breakdown(order)}\nReply 'confirm' to accept these details.", None
    if not explicit_confirmation(user_message) or state.pending is None:
        state.pending = None
        raise OrderValidationError("A complete quote and explicit confirmation are required before dispatch.")
    if confirmation_fingerprint(order) != confirmation_fingerprint(state.pending):
        state.pending = None
        raise OrderValidationError("The order changed after its quote. Review and confirm a fresh quote.")
    state.confirmed = True
    state.pending = None
    return text, order


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def dispatch_order(order: dict) -> dict:
    url = os.environ.get("ORDER_WEBHOOK_URL", "http://127.0.0.1:5000/webhooks/orders")
    parsed = urlparse(url)
    try:
        valid_port = parsed.port is None or 0 < parsed.port <= 65535
    except ValueError:
        valid_port = False
    if (
        not parsed.hostname or parsed.username is not None or parsed.password is not None
        or parsed.fragment or not valid_port
        or parsed.scheme not in {"http", "https"}
        or (parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost"})
    ):
        raise ValueError("ORDER_WEBHOOK_URL must use HTTPS or local loopback HTTP.")
    secret = os.environ.get("WEBHOOK_SECRET", "")
    if not secret:
        raise ValueError("Set WEBHOOK_SECRET before using --dispatch.")
    req = request.Request(
        url, data=json.dumps(order, ensure_ascii=False).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
    )
    with request.build_opener(NoRedirect).open(req, timeout=30) as response:
        return json.load(response)


def create_app(config: dict | None = None):
    """Build the HTTP service for Gunicorn, Render, and signed Meta webhooks."""
    load_env()
    from flask import Response, request
    from webhook import CONFIG_KEYS, create_app as create_order_app
    from messenger import register_messenger

    server_keys = (*CONFIG_KEYS, "FB_APP_SECRET", "FB_PAGE_ACCESS_TOKEN", "FB_PAGE_ID", "FB_VERIFY_TOKEN",
                   "GEMINI_API_KEY", "GEMINI_MODEL", "MESSENGER_DB_PATH", "MESSENGER_BACKGROUND_WORKER",
                   "MESSENGER_HISTORY_MESSAGES", "RENDER", "FULFILLMENT_STATE_DURABLE")
    settings = {key: os.environ[key] for key in server_keys if key in os.environ}
    if config:
        settings.update(config)
    if settings.get("FB_PAGE_ACCESS_TOKEN"):
        settings["META_PAGE_ACCESS_TOKEN"] = settings["FB_PAGE_ACCESS_TOKEN"]
    if settings.get("FB_PAGE_ID"):
        settings["META_PAGE_ID"] = settings["FB_PAGE_ID"]
    # Free Render instances have ephemeral storage; never treat their local DB
    # as durable fulfillment state just because it exists for this process.
    durable = str(settings.get("FULFILLMENT_STATE_DURABLE", "false")).casefold() == "true"
    if settings.get("RENDER") and settings.get("DELIVERY_MODE") == "live" and not durable:
        raise RuntimeError("Live fulfillment on Render requires verified durable state; keep DELIVERY_MODE=dry_run for a free demo.")
    settings["MESSENGER_ROUTE_ENABLED"] = True
    settings["MESSENGER_BACKGROUND_WORKER"] = str(settings.get("MESSENGER_BACKGROUND_WORKER", "true")).casefold() == "true"
    service = create_order_app(settings)

    @service.route("/webhook", methods=["GET"])
    def verify_webhook():
        mode = request.args.get("hub.mode")
        token = request.args.get("hub.verify_token")
        challenge = request.args.get("hub.challenge")
        verify_token = service.config.get(
            "FB_VERIFY_TOKEN", os.environ.get("FB_VERIFY_TOKEN", "my_custom_secret_verify_token_123")
        )
        if mode == "subscribe" and token == verify_token:
            return Response(str(challenge), status=200, content_type="text/plain")
        return "Verification failed", 403

    def order_handler(order: dict) -> dict:
        # Dispatch inside this application; no loopback port assumptions or
        # outbound HTTP retries when Gunicorn binds Render's assigned port.
        with service.test_client() as internal_client:
            response = internal_client.post(
                "/webhooks/orders", json=order,
                headers={"Authorization": "Bearer " + service.config["WEBHOOK_SECRET"]},
            )
        result = response.get_json() or {}
        result["http_status"] = response.status_code
        return result

    processor = register_messenger(service, service.config, order_handler=order_handler)
    service.extensions["messenger_processor"] = processor
    return service


class LazyApplication:
    """Initialize the WSGI app once without changing imports for CLI users."""

    def __init__(self):
        self._application = None
        self._lock = threading.Lock()

    def application(self):
        if self._application is None:
            with self._lock:
                if self._application is None:
                    self._application = create_app()
        return self._application

    def __call__(self, environ, start_response):
        return self.application()(environ, start_response)

    def run(self, **kwargs):
        return self.application().run(**kwargs)


app = LazyApplication()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--message", help="Send one message instead of opening an interactive chat.")
    parser.add_argument("--dispatch", action="store_true", help="Forward validated confirmed orders to the webhook.")
    parser.add_argument("--serve", action="store_true", help="Run the HTTP service; Render uses gunicorn app:app.")
    args = parser.parse_args(argv)
    load_env()
    if args.serve:
        port = int(os.environ.get("PORT", 5000))
        app.run(host="0.0.0.0", port=port)
        return 0
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key or api_key == "YOUR_GEMINI_API_KEY":
        parser.error("Set GEMINI_API_KEY in your environment or local .env file.")
    if args.dispatch and not os.environ.get("WEBHOOK_SECRET"):
        parser.error("Set WEBHOOK_SECRET to use --dispatch.")
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)

    def new_chat():
        state = OrderState(f"AURA-{uuid.uuid4().hex}")
        chat = client.chats.create(
            model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
            config=types.GenerateContentConfig(
                system_instruction=system_instructions(state.order_id), temperature=0.3,
            ),
        )
        return chat, state

    chat, state = new_chat()
    if not args.message:
        print("Aura ready. /new starts a fresh order; /quit exits.")
    try:
        while True:
            try:
                user_message = args.message if args.message is not None else input("You: ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if user_message.casefold() in {"/quit", "quit", "exit"}:
                break
            if user_message == "/new":
                chat, state = new_chat()
                print("Started a fresh order.")
                continue
            if not user_message:
                continue
            try:
                response = chat.send_message(user_message)
                rendered, order = process_response(response.text or "", user_message, state)
                print(f"Aura: {rendered}")
                if order and args.dispatch:
                    try:
                        result = dispatch_order(order)
                        print("Webhook result:", json.dumps(result, ensure_ascii=False))
                    except (error.URLError, TimeoutError, ValueError) as exc:
                        # Do not automatically retry: an order may already have reached the courier.
                        status = f"HTTP {exc.code}" if isinstance(exc, error.HTTPError) else type(exc).__name__
                        print(f"Dispatch needs review ({status}). Check webhook state before retrying.", file=sys.stderr)
                elif order:
                    print("Order captured locally. Start with --dispatch to enable webhook forwarding.")
            except OrderValidationError as exc:
                state.pending = None
                print(f"Order check: {exc}", file=sys.stderr)
            except Exception as exc:
                state.pending = None
                print(f"Chat request failed ({type(exc).__name__}); check API configuration and quota.", file=sys.stderr)
                if args.message is not None:
                    return 1
            if args.message is not None:
                break
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
