"""Signed Meta webhooks and a durable, single-worker Messenger chat queue.

The queue does not replay requests that may already have called an external API.
Run one Gunicorn process: the SQLite file is demo storage on an ephemeral host.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid

from flask import Response, request

import integrations


SERVICE_UNAVAILABLE = "Aura is temporarily unavailable. Please try again later or contact the Page team."
ORDER_REVIEW = "I could not verify this order. Please review your product, delivery address and price details again before confirming."
SESSION_SECONDS = 24 * 60 * 60
_ORDER_BLOCK = re.compile(r"(?:^|\n)```json[ \t]*\r?\n(?:(?!\r?\n```)[\s\S])*\r?\n```[ \t]*\s*\Z")


def _enabled(value):
    return str(value).casefold() not in {"false", "0", "no", "off", ""}


def _digits(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[0-9]{1,64}", value))


def _iso_timestamp(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat()


def _visible_reply(rendered, model_text):
    """Remove the validated final machine payload, keeping the verified quote."""
    match = _ORDER_BLOCK.search(model_text)
    if match:
        rendered = rendered.replace(match.group(), "", 1)
    return rendered.strip()


def _language(text, history, model_text=""):
    from app import explicit_confirmation

    meaningful = [text] if not explicit_confirmation(text) else []
    meaningful += [item["text"] for item in reversed(history) if item["role"] == "user" and not explicit_confirmation(item["text"])]
    meaningful += [model_text]
    for value in meaningful:
        if re.search(r"[\u0980-\u09ff]", value):
            return "bn"
        if re.search(r"\b(?:bhaiya|bhai|apu|ami|amar|amake|koto|qto|dam|eita|eitar|ache|naki|chai|chacchi|koren|korun|korbo|hobe|taka|ekhon)\b", value, re.I):
            return "banglish"
        if value.strip() and value != "/new":
            return "en"
    return "en"


def _quote_text(order, language):
    from app import breakdown

    if language != "bn":
        return breakdown(order)
    price = order["pricing_summary"]
    return f"সাবটোটাল ৳{price['subtotal_bdt']} - ছাড় ৳{price['discount_applied_bdt']} + ডেলিভারি ৳{price['delivery_charge_bdt']} = ক্যাশ অন ডেলিভারি মোট ৳{price['grand_total_bdt']}"


def _review_text(order, language):
    from orders import load_catalog

    customer = order["customer"]
    catalog = load_catalog()
    items = ", ".join(f"{catalog[item['product_id']]['item_name']} ({item['product_id']}) × {item['quantity']} @ ৳{item['unit_price_bdt']}" for item in order["items"])
    eta = {"INSIDE_DHAKA": "24–48", "DHAKA_SUBURBS": "2–3", "OUTSIDE_DHAKA": "2–4"}[customer["zone"]]
    hours = customer["zone"] == "INSIDE_DHAKA"
    address = f"{customer['address_line']}, {customer['thana']}, {customer['district']}"
    courier = order["logistics"]["courier_partner"]
    quote = _quote_text(order, language)
    if language == "bn":
        return f"অর্ডারের তথ্য যাচাই করুন:\nনাম: {customer['full_name']}\nফোন: {customer['phone_number']}\nঠিকানা: {address}\nপণ্য: {items}\nকুরিয়ার: {courier}; ক্যাশ অন ডেলিভারি। আনুমানিক {eta} {'ঘণ্টা' if hours else 'দিন'}।\nযাচাইকৃত হিসাব: {quote}\nতথ্য ঠিক থাকলে 'কনফার্ম করুন' লিখুন।"
    if language == "banglish":
        return f"Apnar order-er details dekhe nin:\nNaam: {customer['full_name']}\nPhone: {customer['phone_number']}\nThikana: {address}\nItems: {items}\nCourier: {courier}; cash on delivery. Anumanik {eta} {'ghonta' if hours else 'din'}.\nVerified quote: {quote}\nShob thik thakle 'ha confirm koren' likhun."
    return f"Please review your order:\nName: {customer['full_name']}\nPhone: {customer['phone_number']}\nAddress: {address}\nItems: {items}\nCourier: {courier}; cash on delivery. Estimate: {eta} {'hours' if hours else 'days'}.\nVerified quote: {quote}\nReply 'confirm' to accept these exact details."


def _receipt_text(order, language):
    quote = _quote_text(order, language)
    if language == "bn":
        return f"আপনার অর্ডার {order['order_id']} গ্রহণ করা হয়েছে।\n{quote}\nকুরিয়ারের অবস্থা ও ট্র্যাকিং পাওয়া গেলে জানানো হবে।"
    if language == "banglish":
        return f"Apnar order {order['order_id']} receive kora hoyeche.\n{quote}\nCourier-er status o tracking pawa gele janano hobe."
    return f"Order {order['order_id']} has been captured.\n{quote}\nFulfillment status and tracking will be shared when available."


class MessengerProcessor:
    def __init__(self, config, order_handler=None):
        self.config = config
        self.order_handler = order_handler
        self.path = str(config.get("MESSENGER_DB_PATH", "work/messenger.sqlite3"))
        if self.path == ":memory:":
            raise ValueError("MESSENGER_DB_PATH must be a persistent SQLite file.")
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._processing = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None
        self._initialize()

    @contextmanager
    def _connection(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        self._protect_files()
        try:
            with connection:
                yield connection
        finally:
            self._protect_files()
            connection.close()

    def _protect_files(self):
        for suffix in ("", "-wal", "-shm"):
            try:
                os.chmod(self.path + suffix, 0o600)
            except FileNotFoundError:
                pass

    def _initialize(self):
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS messenger_sessions (
                    page_id TEXT NOT NULL, psid TEXT NOT NULL,
                    order_id TEXT NOT NULL, pending TEXT, confirmed INTEGER NOT NULL,
                    history TEXT NOT NULL, last_timestamp INTEGER NOT NULL,
                    quote_sent_at INTEGER,
                    PRIMARY KEY (page_id, psid)
                );
                CREATE TABLE IF NOT EXISTS messenger_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    page_id TEXT NOT NULL, event_id TEXT NOT NULL, psid TEXT NOT NULL,
                    timestamp INTEGER NOT NULL, user_text TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending', reply TEXT,
                    order_json TEXT, outbound TEXT, dispatch TEXT,
                    reviewed_quote INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    UNIQUE (page_id, event_id)
                );
                CREATE INDEX IF NOT EXISTS messenger_queue
                    ON messenger_events (state, sequence);
            """)
            for table, column, definition in (
                ("messenger_sessions", "quote_sent_at", "INTEGER"),
                ("messenger_events", "reviewed_quote", "INTEGER NOT NULL DEFAULT 0"),
            ):
                if column not in {row["name"] for row in connection.execute("PRAGMA table_info(" + table + ")")}:
                    connection.execute("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition)
            # A crash can happen after a successful external request and before
            # its result was saved. These states require a human to reconcile.
            interrupted = connection.execute(
                "SELECT page_id, psid FROM messenger_events WHERE state IN ('processing', 'sending', 'dispatching')"
            ).fetchall()
            for row in interrupted:
                connection.execute(
                    "UPDATE messenger_sessions SET pending = NULL, quote_sent_at = NULL WHERE page_id = ? AND psid = ?",
                    (row["page_id"], row["psid"]),
                )
            connection.execute(
                "UPDATE messenger_events SET state = 'reconcile', outbound = ? WHERE state IN ('processing', 'sending', 'dispatching')",
                (json.dumps({"error": "interrupted_request_needs_review"}),),
            )
            self._protect_files()

    def start(self):
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="aura-messenger", daemon=True)
        self._thread.start()

    def close(self):
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=2)

    def _run(self):
        while not self._stop.is_set():
            if not self.process_pending(limit=1):
                self._wake.wait(1)
                self._wake.clear()

    def enqueue(self, payload):
        page_id = str(self.config.get("FB_PAGE_ID") or self.config.get("META_PAGE_ID") or "")
        if not page_id or payload.get("object") != "page":
            return 0
        entries = payload.get("entry")
        if not isinstance(entries, list):
            return 0
        queued = 0
        with self._connection() as connection:
            for entry in entries:
                if not isinstance(entry, dict) or str(entry.get("id", "")) != page_id:
                    continue
                events = entry.get("messaging", [])
                if not isinstance(events, list):
                    continue
                for event in events:
                    if not isinstance(event, dict):
                        continue
                    sender, recipient = event.get("sender"), event.get("recipient")
                    if not isinstance(sender, dict) or not isinstance(recipient, dict):
                        continue
                    psid = sender.get("id")
                    if not _digits(psid) or psid == page_id or recipient.get("id") != page_id:
                        continue
                    timestamp = event.get("timestamp")
                    if type(timestamp) is not int or timestamp <= 0 or timestamp > int(time.time() * 1000):
                        continue
                    try:
                        _iso_timestamp(timestamp)
                    except (ValueError, OverflowError, OSError):
                        continue
                    if "delivery" in event or "read" in event:
                        continue
                    message = event.get("message")
                    postback = event.get("postback")
                    if isinstance(message, dict):
                        if message.get("is_echo"):
                            continue
                        event_id, user_text = message.get("mid"), message.get("text")
                    elif isinstance(postback, dict):
                        event_id, user_text = postback.get("mid"), postback.get("payload")
                        if event_id is None and isinstance(user_text, str) and 1 <= len(user_text.strip()) <= 4000:
                            identity = json.dumps([page_id, psid, timestamp, user_text], ensure_ascii=False, separators=(",", ":"))
                            event_id = "postback-" + hashlib.sha256(identity.encode()).hexdigest()
                    else:
                        continue
                    if not isinstance(event_id, str) or not 1 <= len(event_id) <= 256:
                        continue
                    if not isinstance(user_text, str) or not 1 <= len(user_text.strip()) <= 4000:
                        continue
                    cursor = connection.execute(
                        "INSERT OR IGNORE INTO messenger_events (page_id, event_id, psid, timestamp, user_text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (page_id, event_id, psid, timestamp, user_text.strip(), time.time()),
                    )
                    queued += cursor.rowcount
        if queued:
            self._wake.set()
        return queued

    def _claim(self):
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM messenger_events WHERE state IN ('pending', 'reply_ready') ORDER BY sequence LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            state = "processing" if row["state"] == "pending" else "sending"
            connection.execute("UPDATE messenger_events SET state = ? WHERE sequence = ?", (state, row["sequence"]))
            return dict(row)

    def process_pending(self, limit=100):
        """Drain queued events synchronously; useful for network-free tests."""
        processed = 0
        with self._processing:
            while processed < limit:
                event = self._claim()
                if event is None:
                    break
                try:
                    self._process(event)
                except Exception:
                    # Never record exception messages: SDK errors may contain a
                    # URL, token or customer content. Do not retry this event.
                    self._clear_pending(event)
                    self._update(event, state="reconcile", outbound={"error": "processing_needs_review"})
                processed += 1
        return processed

    def _update(self, event, **fields):
        allowed = {"state", "reply", "order_json", "outbound", "dispatch"}
        if not fields.keys() <= allowed:
            raise ValueError("Unsupported event update.")
        values = [json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else value for value in fields.values()]
        with self._connection() as connection:
            connection.execute(
                "UPDATE messenger_events SET " + ", ".join(name + " = ?" for name in fields) + " WHERE sequence = ?",
                (*values, event["sequence"]),
            )

    def _clear_pending(self, event):
        with self._connection() as connection:
            connection.execute(
                "UPDATE messenger_sessions SET pending = NULL, quote_sent_at = NULL WHERE page_id = ? AND psid = ?",
                (event["page_id"], event["psid"]),
            )

    def _session_record(self, event):
        with self._connection() as connection:
            return connection.execute(
                "SELECT * FROM messenger_sessions WHERE page_id = ? AND psid = ?",
                (event["page_id"], event["psid"]),
            ).fetchone()

    def _session(self, event):
        from app import OrderState

        row = self._session_record(event)
        if row is None or event["timestamp"] - row["last_timestamp"] > SESSION_SECONDS * 1000:
            return OrderState("AURA-" + uuid.uuid4().hex), []
        return OrderState(row["order_id"], json.loads(row["pending"]) if row["pending"] else None, bool(row["confirmed"])), json.loads(row["history"])

    def _save_reply(self, event, state, history, reply, order, reviewed_quote=False):
        maximum = max(2, min(int(self.config.get("MESSENGER_HISTORY_MESSAGES", 20)), 100))
        history = history[-maximum:]
        if history and history[0]["role"] == "model":
            history = history[1:]
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO messenger_sessions (page_id, psid, order_id, pending, confirmed, history, last_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(page_id, psid) DO UPDATE SET order_id = excluded.order_id, pending = excluded.pending, confirmed = excluded.confirmed, "
                "history = excluded.history, last_timestamp = MAX(last_timestamp, excluded.last_timestamp), "
                "quote_sent_at = CASE WHEN excluded.pending IS NULL OR ? THEN NULL ELSE quote_sent_at END",
                (event["page_id"], event["psid"], state.order_id, json.dumps(state.pending, ensure_ascii=False) if state.pending else None,
                 int(state.confirmed), json.dumps(history, ensure_ascii=False), event["timestamp"], int(reviewed_quote)),
            )
            connection.execute(
                "UPDATE messenger_events SET state = 'reply_ready', reply = ?, order_json = ?, reviewed_quote = ? WHERE sequence = ?",
                (reply, json.dumps(order, ensure_ascii=False) if order else None, int(reviewed_quote), event["sequence"]),
            )
            self._protect_files()

    def _model_reply(self, state, history, user_text):
        from app import system_instructions

        api_key = self.config.get("GEMINI_API_KEY") or os.environ.get("GEMINI_API_KEY")
        if not api_key or api_key == "YOUR_GEMINI_API_KEY":
            raise RuntimeError("Gemini configuration unavailable.")
        adapter = self.config.get("MESSENGER_MODEL_REPLY")
        if adapter is not None:
            return adapter(state, history, user_text)
        # Import only when the first configured message is processed.
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=20_000))
        try:
            chat = client.chats.create(
                model=self.config.get("GEMINI_MODEL", "gemini-2.5-flash"),
                config=types.GenerateContentConfig(system_instruction=system_instructions(state.order_id), temperature=0.3),
                history=[types.Content(role=item["role"], parts=[types.Part.from_text(text=item["text"])]) for item in history],
            )
            return chat.send_message(user_text).text or ""
        finally:
            client.close()

    def _send(self, event, reply):
        config = dict(self.config)
        config["META_PAGE_ID"] = config.get("FB_PAGE_ID") or config.get("META_PAGE_ID")
        config["META_PAGE_ACCESS_TOKEN"] = config.get("FB_PAGE_ACCESS_TOKEN") or config.get("META_PAGE_ACCESS_TOKEN")
        recipient = {"messenger_psid": event["psid"], "messenger_last_interaction_at": _iso_timestamp(event["timestamp"])}
        try:
            self._update(event, state="sending")
            result = integrations._send_messenger(recipient, reply[:2000], config)
            if result.get("skipped"):
                self._clear_pending(event)
            else:
                with self._connection() as connection:
                    row = connection.execute("SELECT reviewed_quote FROM messenger_events WHERE sequence = ?", (event["sequence"],)).fetchone()
                    if row and row["reviewed_quote"]:
                        connection.execute(
                            "UPDATE messenger_sessions SET quote_sent_at = ? WHERE page_id = ? AND psid = ? AND pending IS NOT NULL",
                            (int(time.time() * 1000), event["page_id"], event["psid"]),
                        )
            self._update(event, state="done", outbound=result)
        except integrations.IntegrationError as error:
            self._clear_pending(event)
            self._update(event, state="reconcile" if error.ambiguous else "failed", outbound={"error": error.code})

    def _dispatch_and_send(self, event, reply, order):
        if order and self.order_handler:
            self._update(event, state="dispatching")
            try:
                result = self.order_handler(order)
            except Exception:
                self._update(event, state="reconcile", dispatch={"error": "order_dispatch_needs_review"})
                return
            if not isinstance(result, dict):
                self._update(event, state="reconcile", dispatch={"error": "order_dispatch_unverified"})
                return
            accepted = (
                result.get("order_id") == order["order_id"]
                and result.get("http_status") in {200, 202, 502}
                and result.get("status") in {"dry_run", "completed", "processing", "reconcile_required", "partial_failure"}
                and result.get("mode") in {"live", "dry_run"}
                and isinstance(result.get("effects"), dict)
            )
            if not accepted:
                definite_rejection = result.get("http_status") in {400, 401, 403, 409, 503}
                self._clear_pending(event)
                if definite_rejection:
                    with self._connection() as connection:
                        connection.execute("UPDATE messenger_sessions SET confirmed = 0 WHERE page_id = ? AND psid = ?", (event["page_id"], event["psid"]))
                self._update(event, dispatch={"error": "order_dispatch_rejected", "http_status": result.get("http_status")})
                self._send(event, ORDER_REVIEW)
                with self._connection() as connection:
                    connection.execute("UPDATE messenger_events SET state = ? WHERE sequence = ? AND state = 'done'", ("failed" if definite_rejection else "reconcile", event["sequence"]))
                return
            # The order webhook can already send this exact confirmation. An
            # uncertain result also must not cause a second send here.
            self._update(event, dispatch=result)
            confirmation = result.get("effects", {}).get("confirmation_messenger", {})
            if result["mode"] == "live":
                # All live confirmation attempts belong to the order effect
                # journal. A separate fallback would leave its failed effect
                # retryable and could send this receipt twice on order replay.
                effect_state = confirmation.get("state")
                state = "done" if effect_state in {"succeeded", "skipped"} else "failed" if effect_state == "failed" else "reconcile"
                self._update(event, state=state, outbound={"delivery": "handled_by_order_webhook", "effect_state": effect_state})
                return
            if confirmation.get("state") in {"succeeded", "in_progress", "unknown"}:
                state = "done" if confirmation["state"] == "succeeded" else "reconcile"
                self._update(event, state=state, outbound={"delivery": "handled_by_order_webhook"})
                return
        self._send(event, reply)

    def _process(self, event):
        from app import explicit_confirmation, process_response
        from orders import OrderValidationError, extract_order

        if event["state"] == "reply_ready":
            self._dispatch_and_send(event, event["reply"], json.loads(event["order_json"]) if event["order_json"] else None)
            return
        previous = self._session_record(event)
        if previous and event["timestamp"] < previous["last_timestamp"]:
            self._clear_pending(event)
            self._update(event, state="done", outbound={"skipped": "stale_message_timestamp"})
            return
        if previous and previous["pending"] and explicit_confirmation(event["user_text"]):
            if previous["quote_sent_at"] is None or event["timestamp"] <= previous["quote_sent_at"]:
                self._clear_pending(event)
                self._update(event, state="done", outbound={"skipped": "confirmation_precedes_delivered_quote"})
                return
        recipient = {"messenger_psid": event["psid"], "messenger_last_interaction_at": _iso_timestamp(event["timestamp"])}
        reason = integrations.messenger_eligibility(recipient)
        if reason:
            self._clear_pending(event)
            self._update(event, state="done", outbound={"skipped": reason})
            return
        state, history = self._session(event)
        text = event["user_text"]
        order = None
        reviewed_quote = False
        if text.casefold() == "/new":
            from app import OrderState
            state, history = OrderState("AURA-" + uuid.uuid4().hex), []
            reply = "Started a fresh order. How can I help?"
            model_text = reply
        else:
            try:
                model_text = self._model_reply(state, history, text)
                if not isinstance(model_text, str) or not model_text.strip() or len(model_text) > 20_000:
                    raise RuntimeError("Invalid model response.")
                rendered, order = process_response(model_text, text, state)
                reply = _visible_reply(rendered, model_text)
                payload = extract_order(model_text)
                language = _language(text, history, _visible_reply(model_text, model_text))
                if payload and payload["order_event"] == "ORDER_DRAFT" and state.pending:
                    reply = _review_text(state.pending, language)
                    reviewed_quote = True
                    if len(reply) > 2000:
                        raise OrderValidationError("The order review is too long for Messenger.")
                if order:
                    # Use verified facts for a receipt; never promise a booking
                    # or a tracking SMS before those effects are known.
                    reply = _receipt_text(order, language)
                if not reply:
                    raise RuntimeError("Empty shopper response.")
            except OrderValidationError:
                state.pending = None
                reply = model_text = ORDER_REVIEW
                order = None
            except Exception:
                state.pending = None
                reply = model_text = SERVICE_UNAVAILABLE
                order = None
        history = [*history, {"role": "user", "text": text}, {"role": "model", "text": model_text}]
        reply = reply[:2000]
        if order:
            order = {**order, "messenger_psid": event["psid"], "messenger_last_interaction_at": _iso_timestamp(event["timestamp"]), "confirmation_message": reply}
        self._save_reply(event, state, history, reply, order, reviewed_quote)
        self._dispatch_and_send(event, reply, order)


def register_messenger(app, config, order_handler=None):
    """Mount signed POST /webhook and return its controllable queue processor."""
    processor = MessengerProcessor(config, order_handler)
    app.extensions["messenger_processor"] = processor

    @app.route("/webhook", methods=["POST"])
    def messenger_webhook():
        secret = config.get("FB_APP_SECRET")
        if not secret:
            return Response("Webhook authentication is not configured.", status=503)
        raw_body = request.get_data(cache=True)
        supplied = request.headers.get("X-Hub-Signature-256", "")
        expected = "sha256=" + hmac.new(str(secret).encode(), raw_body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(supplied.encode(), expected.encode()):
            return Response("Signature verification failed.", status=403)
        try:
            payload = json.loads(raw_body)
        except (UnicodeError, ValueError):
            return Response("Invalid JSON.", status=400)
        if not isinstance(payload, dict):
            return Response("Invalid payload.", status=400)
        processor.enqueue(payload)
        return Response("EVENT_RECEIVED", content_type="text/plain")

    if _enabled(config.get("MESSENGER_BACKGROUND_WORKER", True)):
        processor.start()
    return processor
