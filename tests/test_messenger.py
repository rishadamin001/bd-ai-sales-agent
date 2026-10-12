"""Signed Messenger requests, durable sessions and replay guards; no network."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import integrations
from messenger import ORDER_REVIEW, SERVICE_UNAVAILABLE, register_messenger
from orders import load_catalog

REAL_SEND_MESSENGER = integrations._send_messenger


def sample_order(order_id, event="ORDER_DRAFT"):
    product = next(item for item in load_catalog().values() if item["stock_status"] == "IN_STOCK")
    price = product["regular_price_bdt"]
    return {
        "order_event": event, "order_id": order_id,
        "items": [{"product_id": product["product_id"], "quantity": 1, "unit_price_bdt": price}],
        "customer": {"full_name": "Demo Customer", "phone_number": "01700000000", "address_line": "House 12, Road 4, Sector 3, Uttara", "thana": "Uttara", "district": "Dhaka", "zone": "INSIDE_DHAKA"},
        "pricing_summary": {"subtotal_bdt": price, "discount_applied_bdt": 0, "delivery_charge_bdt": 70, "grand_total_bdt": price + 70},
        "logistics": {"courier_partner": "STEADFAST", "payment_method": "CASH_ON_DELIVERY"},
    }


def model_order(order):
    return "Please review these details.\n\n```json\n" + json.dumps(order) + "\n```"


class MessengerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.model = Mock(return_value="Hello! How can I help?")
        self.config = {
            "FB_APP_SECRET": "test-app-secret", "FB_VERIFY_TOKEN": "test-verify-token",
            "FB_PAGE_ID": "123456", "FB_PAGE_ACCESS_TOKEN": "test-page-token",
            "META_GRAPH_VERSION": "v23.0",
            "GEMINI_API_KEY": "test-gemini-key", "MESSENGER_MODEL_REPLY": self.model,
            "MESSENGER_BACKGROUND_WORKER": False,
            "MESSENGER_DB_PATH": str(Path(self.temp.name) / "messenger.sqlite3"),
            "DELIVERY_MODE": "dry_run",
        }
        self.sent = patch("integrations._send_messenger", return_value={"delivery": "messenger_message_sent", "message_id": "mock-response"}).start()
        self.addCleanup(patch.stopall)
        self.app, self.processor = self.make_app()
        self.client = self.app.test_client()

    def make_app(self, config=None, handler=None):
        app = Flask("messenger-test")
        app.config.update(self.config if config is None else config)
        processor = register_messenger(app, app.config, handler)
        self.addCleanup(processor.close)
        return app, processor

    def payload(self, mid="m-1", text="hello", psid="777", timestamp=None):
        if text == "confirm" and timestamp is None:
            # Meta timestamps must follow the completed outbound quote send.
            time.sleep(0.003)
        return {"object": "page", "entry": [{"id": "123456", "messaging": [{
            "sender": {"id": psid}, "recipient": {"id": "123456"},
            "timestamp": int(time.time() * 1000) if timestamp is None else timestamp,
            "message": {"mid": mid, "text": text},
        }]}]}

    def post(self, payload=None, client=None, signature=None, raw=None):
        body = raw if raw is not None else json.dumps(self.payload() if payload is None else payload).encode()
        supplied = signature or "sha256=" + hmac.new(b"test-app-secret", body, hashlib.sha256).hexdigest()
        return (client or self.client).post("/webhook", data=body, content_type="application/json", headers={"X-Hub-Signature-256": supplied})

    def rows(self, table="messenger_events"):
        with sqlite3.connect(self.config["MESSENGER_DB_PATH"]) as connection:
            connection.row_factory = sqlite3.Row
            return [dict(row) for row in connection.execute("SELECT * FROM " + table)]

    def chat_orders(self, state, history, user_text):
        event = "ORDER_CONFIRMED" if user_text == "confirm" else "ORDER_DRAFT"
        return model_order(sample_order(state.order_id, event))

    def acknowledged(self, order, effect="planned", status="dry_run", http_status=200):
        return {"order_id": order["order_id"], "mode": "dry_run" if status == "dry_run" else "live", "status": status, "http_status": http_status, "effects": {"confirmation_messenger": {"state": effect}}}

    def test_verification_challenge_and_exact_token(self):
        response = self.client.get("/webhook", query_string={"hub.mode": "subscribe", "hub.verify_token": "test-verify-token", "hub.challenge": "12345"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_data(as_text=True), "12345")
        self.assertEqual(response.mimetype, "text/plain")
        for token in ("wrong", "test-verify-token ", ""):
            response = self.client.get("/webhook", query_string={"hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "12345"})
            self.assertEqual(response.status_code, 403)
        self.app.config["FB_VERIFY_TOKEN"] = ""
        self.assertEqual(self.client.get("/webhook").status_code, 503)

    def test_signature_rejected_before_json_or_model(self):
        response = self.post(raw=b"not json", signature="sha256=bad")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.rows(), [])
        self.model.assert_not_called()
        self.sent.assert_not_called()
        self.assertEqual(self.post(raw=b"not json").status_code, 400)
        self.app.config["FB_APP_SECRET"] = ""
        self.assertEqual(self.post().status_code, 503)

    def test_signed_raw_body_required_and_unknown_page_skipped(self):
        payload = self.payload()
        payload["entry"][0]["id"] = "999"
        self.assertEqual(self.post(payload).status_code, 200)
        self.assertEqual(self.rows(), [])
        body = json.dumps(self.payload()).encode()
        signature = "sha256=" + hmac.new(b"test-app-secret", body, hashlib.sha256).hexdigest()
        self.assertEqual(self.post(raw=body + b" ", signature=signature).status_code, 403)

    def test_acknowledgement_queues_without_model_and_ordinary_dry_run_sends(self):
        self.assertEqual(self.post().status_code, 200)
        self.model.assert_not_called()
        self.sent.assert_not_called()
        self.assertEqual(self.rows()[0]["state"], "pending")
        self.assertEqual(self.processor.process_pending(), 1)
        self.model.assert_called_once()
        self.sent.assert_called_once()
        args = self.sent.call_args.args
        self.assertEqual(args[0]["messenger_psid"], "777")
        self.assertEqual(args[2]["META_PAGE_ID"], "123456")
        self.assertEqual(args[2]["META_PAGE_ACCESS_TOKEN"], "test-page-token")
        self.assertEqual(self.rows()[0]["state"], "done")

    def test_echo_delivery_read_wrong_recipient_and_invalid_timestamps_skipped(self):
        variants = []
        for field in ("delivery", "read"):
            payload = self.payload(field)
            payload["entry"][0]["messaging"][0][field] = {}
            variants.append(payload)
        echo = self.payload("echo")
        echo["entry"][0]["messaging"][0]["message"]["is_echo"] = True
        variants.append(echo)
        wrong = self.payload("wrong-recipient")
        wrong["entry"][0]["messaging"][0]["recipient"]["id"] = "999"
        variants.append(wrong)
        variants.extend(self.payload(str(value), timestamp=value) for value in (0, -1, True, "123", int(time.time() * 1000) + 60_000, 10 ** 30))
        for payload in variants:
            self.assertEqual(self.post(payload).status_code, 200)
        self.assertEqual(self.processor.process_pending(), 0)
        self.assertEqual(self.rows(), [])

    def test_postback_payload_is_user_text_and_mid_deduplicates(self):
        payload = self.payload()
        event = payload["entry"][0]["messaging"][0]
        del event["message"]
        event["postback"] = {"mid": "postback-1", "payload": "SHOW_PRODUCTS", "title": "Products"}
        self.post(payload)
        self.post(payload)
        self.processor.process_pending()
        self.assertEqual(self.model.call_args.args[2], "SHOW_PRODUCTS")
        self.assertEqual(self.model.call_count, 1)
        self.assertEqual(self.sent.call_count, 1)

    def test_event_duplicate_survives_restart_without_gemini_send_or_order(self):
        self.post()
        self.processor.process_pending()
        self.processor.close()
        app, restarted = self.make_app()
        self.post(client=app.test_client())
        self.assertEqual(restarted.process_pending(), 0)
        self.assertEqual(self.model.call_count, 1)
        self.assertEqual(self.sent.call_count, 1)

    def test_pending_event_recovers_after_restart(self):
        self.post()
        self.processor.close()
        _, restarted = self.make_app()
        self.assertEqual(restarted.process_pending(), 1)
        self.assertEqual(self.model.call_count, 1)
        self.assertEqual(self.sent.call_count, 1)

    def test_separate_psids_never_share_history_or_order_ids(self):
        self.post(self.payload("a-1", "first customer", "777"))
        self.post(self.payload("b-1", "second customer", "888"))
        self.post(self.payload("a-2", "first followup", "777"))
        self.processor.process_pending()
        calls = self.model.call_args_list
        self.assertEqual(calls[0].args[1], [])
        self.assertEqual(calls[1].args[1], [])
        self.assertEqual(calls[2].args[1][0]["text"], "first customer")
        self.assertNotEqual(calls[0].args[0].order_id, calls[1].args[0].order_id)
        self.assertEqual(calls[0].args[0].order_id, calls[2].args[0].order_id)

    def test_new_command_clears_history_and_creates_new_order(self):
        self.post()
        self.processor.process_pending()
        old_id = self.rows("messenger_sessions")[0]["order_id"]
        self.post(self.payload("m-new", "/new"))
        self.processor.process_pending()
        session = self.rows("messenger_sessions")[0]
        self.assertNotEqual(session["order_id"], old_id)
        self.assertIsNone(session["pending"])
        self.assertFalse(session["confirmed"])
        self.assertEqual(self.model.call_count, 1)
        self.post(self.payload("m-followup", "products"))
        self.processor.process_pending()
        self.assertNotIn("hello", json.dumps(self.model.call_args.args[1]))

    def test_session_expires_after_24_hours_and_history_is_bounded(self):
        self.app.config["MESSENGER_HISTORY_MESSAGES"] = 4
        for index in range(4):
            self.post(self.payload("m-" + str(index), "text " + str(index)))
            self.processor.process_pending()
        session = self.rows("messenger_sessions")[0]
        self.assertEqual(len(json.loads(session["history"])), 4)
        with sqlite3.connect(self.config["MESSENGER_DB_PATH"]) as connection:
            connection.execute("UPDATE messenger_sessions SET last_timestamp = last_timestamp - ?", (25 * 60 * 60 * 1000,))
        self.post(self.payload("m-expired"))
        self.processor.process_pending()
        self.assertEqual(self.model.call_args.args[1], [])
        self.assertNotEqual(self.rows("messenger_sessions")[0]["order_id"], session["order_id"])

    def test_outside_24_hour_response_window_never_calls_model_or_send(self):
        self.post(self.payload(timestamp=int(time.time() * 1000) - 25 * 60 * 60 * 1000))
        self.processor.process_pending()
        self.model.assert_not_called()
        self.sent.assert_not_called()
        self.assertIn("outside_messenger_response_window", self.rows()[0]["outbound"])

    def test_draft_has_verified_review_and_confirmed_order_has_trusted_identity(self):
        self.model.side_effect = self.chat_orders
        handler = Mock(side_effect=lambda order: self.acknowledged(order))
        self.processor.order_handler = handler
        self.post(self.payload("m-draft", "Here are my order details"))
        self.processor.process_pending()
        review = self.sent.call_args.args[1]
        self.assertIn("Verified quote:", review)
        self.assertIn("House 12, Road 4", review)
        self.assertNotIn("```", review)
        self.assertNotIn("ORDER_DRAFT", review)
        handler.assert_not_called()
        self.post(self.payload("m-confirm", "confirm"))
        self.processor.process_pending()
        handler.assert_called_once()
        order = handler.call_args.args[0]
        self.assertEqual(order["messenger_psid"], "777")
        self.assertGreater(datetime.fromisoformat(order["messenger_last_interaction_at"]).timestamp(), time.time() - 10)
        self.assertEqual(order["confirmation_message"], self.sent.call_args.args[1])
        self.assertNotIn("ORDER_CONFIRMED", self.sent.call_args.args[1])
        self.assertTrue(self.rows("messenger_sessions")[0]["confirmed"])
        self.post(self.payload("m-confirm", "confirm"))
        self.processor.process_pending()
        self.assertEqual(handler.call_count, 1)
        self.assertEqual(self.model.call_count, 2)
        self.assertEqual(self.sent.call_count, 2)

    def test_confirmation_effect_sent_or_uncertain_does_not_send_twice(self):
        self.model.side_effect = self.chat_orders
        handler = Mock(side_effect=lambda order: self.acknowledged(order, "succeeded", "completed"))
        self.processor.order_handler = handler
        self.post(self.payload("m-draft", "Here are my details"))
        self.processor.process_pending()
        self.post(self.payload("m-confirm", "confirm"))
        self.processor.process_pending()
        self.assertEqual(self.sent.call_count, 1)
        handler.assert_called_once()
        self.assertEqual(self.rows()[-1]["state"], "done")

    def test_confirmation_without_quote_or_changed_quote_cannot_dispatch(self):
        handler = Mock()
        self.processor.order_handler = handler
        self.model.side_effect = self.chat_orders
        self.post(self.payload("m-early", "confirm"))
        self.processor.process_pending()
        handler.assert_not_called()
        self.assertEqual(self.sent.call_args.args[1], ORDER_REVIEW)
        self.post(self.payload("m-draft", "Here are my details"))
        self.processor.process_pending()

        def changed_order(state, history, text):
            order = sample_order(state.order_id, "ORDER_CONFIRMED")
            order["customer"]["address_line"] = "House 13, Road 4, Sector 3, Uttara"
            return model_order(order)

        self.model.side_effect = changed_order
        self.post(self.payload("m-changed", "confirm"))
        self.processor.process_pending()
        handler.assert_not_called()
        self.assertEqual(self.sent.call_args.args[1], ORDER_REVIEW)
        self.assertIsNone(self.rows("messenger_sessions")[0]["pending"])

    def test_model_cannot_choose_messenger_identity(self):
        def bad_order(state, history, text):
            order = sample_order(state.order_id)
            order["messenger_psid"] = "999999"
            return model_order(order)

        self.model.side_effect = bad_order
        self.post()
        self.processor.process_pending()
        self.assertEqual(self.sent.call_args.args[1], ORDER_REVIEW)
        self.assertIsNone(self.rows("messenger_sessions")[0]["pending"])

    def test_missing_gemini_key_does_not_import_sdk_and_replies_safely(self):
        self.app.config["GEMINI_API_KEY"] = ""
        with patch.dict("os.environ", {}, clear=True), patch.dict(sys.modules, {"google.genai": None}):
            self.post()
            self.processor.process_pending()
        self.model.assert_not_called()
        self.assertEqual(self.sent.call_args.args[1], SERVICE_UNAVAILABLE)
        self.assertEqual(self.rows()[0]["state"], "done")

    def test_sdk_failure_clears_quote_and_never_exposes_exception(self):
        self.model.side_effect = self.chat_orders
        self.post()
        self.processor.process_pending()
        self.assertIsNotNone(self.rows("messenger_sessions")[0]["pending"])
        self.model.side_effect = RuntimeError("secret-token and customer address")
        self.post(self.payload("m-error", "confirm"))
        self.processor.process_pending()
        self.assertEqual(self.sent.call_args.args[1], SERVICE_UNAVAILABLE)
        self.assertIsNone(self.rows("messenger_sessions")[0]["pending"])
        self.assertNotIn("secret-token", json.dumps(self.rows()))

    def test_ambiguous_send_never_retries_on_duplicate_or_restart(self):
        self.sent.side_effect = integrations.IntegrationError("transport_error", ambiguous=True)
        self.post()
        self.processor.process_pending()
        self.assertEqual(self.rows()[0]["state"], "reconcile")
        _, restarted = self.make_app()
        self.post()
        self.assertEqual(restarted.process_pending(), 0)
        self.assertEqual(self.sent.call_count, 1)
        self.assertEqual(self.model.call_count, 1)

    def test_interrupted_processing_is_marked_reconcile_without_retry(self):
        self.post()
        with sqlite3.connect(self.config["MESSENGER_DB_PATH"]) as connection:
            connection.execute("UPDATE messenger_events SET state = 'processing'")
        _, restarted = self.make_app()
        self.assertEqual(restarted.process_pending(), 0)
        self.assertEqual(self.rows()[0]["state"], "reconcile")
        self.model.assert_not_called()
        self.sent.assert_not_called()

    def test_saved_reply_recovers_without_repeating_gemini(self):
        self.post()
        event = self.processor._claim()
        state, history = self.processor._session(event)
        self.processor._save_reply(event, state, history, "Saved reply", None)
        _, restarted = self.make_app()
        self.assertEqual(restarted.process_pending(), 1)
        self.model.assert_not_called()
        self.assertEqual(self.sent.call_args.args[1], "Saved reply")

    def test_interrupted_dispatch_does_not_rebook_or_repeat_confirmation(self):
        self.model.side_effect = self.chat_orders
        self.post(self.payload("m-draft", "Here are my details"))
        self.processor.process_pending()
        handler = Mock(side_effect=RuntimeError("uncertain courier response"))
        self.processor.order_handler = handler
        self.post(self.payload("m-confirm", "confirm"))
        self.processor.process_pending()
        self.assertEqual(self.rows()[-1]["state"], "reconcile")
        _, restarted = self.make_app(handler=handler)
        self.assertEqual(restarted.process_pending(), 0)
        self.assertEqual(handler.call_count, 1)
        self.assertEqual(self.sent.call_count, 1)
        self.assertTrue(self.rows("messenger_sessions")[0]["confirmed"])

    def test_background_worker_ack_does_not_wait_for_model(self):
        entered, release = threading.Event(), threading.Event()

        def slow_model(*args):
            entered.set()
            release.wait(3)
            return "Done"

        self.model.side_effect = slow_model
        self.processor.start()
        started = time.monotonic()
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(entered.wait(2))
        release.set()
        self.processor.close()
        self.assertEqual(self.sent.call_count, 1)

    def test_real_sdk_bridge_uses_timeout_model_and_persisted_history(self):
        self.app.config.pop("MESSENGER_MODEL_REPLY")
        client = Mock()
        client.chats.create.return_value.send_message.return_value.text = "Hello from mock SDK"
        genai = types.ModuleType("google.genai")
        genai.Client = Mock(return_value=client)
        sdk_types = types.ModuleType("google.genai.types")
        sdk_types.HttpOptions = lambda **kwargs: types.SimpleNamespace(**kwargs)
        sdk_types.GenerateContentConfig = lambda **kwargs: types.SimpleNamespace(**kwargs)
        sdk_types.Content = lambda **kwargs: types.SimpleNamespace(**kwargs)
        sdk_types.Part = types.SimpleNamespace(from_text=lambda **kwargs: types.SimpleNamespace(**kwargs))
        genai.types = sdk_types
        google = types.ModuleType("google")
        google.genai = genai
        with patch.dict(sys.modules, {"google": google, "google.genai": genai, "google.genai.types": sdk_types}):
            self.post()
            self.processor.process_pending()
            self.post(self.payload("m-follow", "followup"))
            self.processor.process_pending()
        config = client.chats.create.call_args.kwargs
        self.assertEqual(config["model"], "gemini-2.5-flash")
        self.assertEqual(config["config"].temperature, 0.3)
        self.assertEqual(config["history"][0].role, "user")
        self.assertEqual(config["history"][0].parts[0].text, "hello")
        self.assertEqual(genai.Client.call_args.kwargs["http_options"].timeout, 20_000)
        self.assertEqual(client.close.call_count, 2)

    def test_delayed_confirmation_cannot_approve_a_newer_amended_quote(self):
        oldest = int(time.time() * 1000) - 3000
        handler = Mock()
        self.processor.order_handler = handler

        def quote_address(state, history, text):
            order = sample_order(state.order_id, "ORDER_CONFIRMED" if text == "confirm" else "ORDER_DRAFT")
            if text == "change to house 13" or text == "confirm":
                order["customer"]["address_line"] = "House 13, Road 4, Sector 3, Uttara"
            return model_order(order)

        self.model.side_effect = quote_address
        self.post(self.payload("draft-a", "original address", timestamp=oldest))
        self.processor.process_pending()
        self.post(self.payload("draft-b", "change to house 13", timestamp=oldest + 2000))
        self.processor.process_pending()
        self.post(self.payload("old-confirm", "confirm", timestamp=oldest + 1000))
        self.processor.process_pending()
        handler.assert_not_called()
        self.assertEqual(self.model.call_count, 2)
        self.assertEqual(self.sent.call_count, 2)
        self.assertIn("stale_message_timestamp", self.rows()[-1]["outbound"])
        self.assertIsNone(self.rows("messenger_sessions")[0]["pending"])

    def test_confirmation_queued_before_review_is_sent_cannot_dispatch(self):
        self.model.side_effect = self.chat_orders
        handler = Mock()
        self.processor.order_handler = handler
        timestamp = int(time.time() * 1000) - 2000
        self.post(self.payload("draft", "my details", timestamp=timestamp))
        self.post(self.payload("too-early", "confirm", timestamp=timestamp + 1000))
        self.assertEqual(self.processor.process_pending(), 2)
        handler.assert_not_called()
        self.assertEqual(self.model.call_count, 1)
        self.assertEqual(self.sent.call_count, 1)
        self.assertIn("confirmation_precedes_delivered_quote", self.rows()[-1]["outbound"])
        self.assertIsNone(self.rows("messenger_sessions")[0]["pending"])

    def test_rejected_order_dispatch_never_sends_a_success_receipt(self):
        self.model.side_effect = self.chat_orders
        handler = Mock()
        self.processor.order_handler = handler
        for status in (400, 409, 500):
            self.post(self.payload("reset-" + str(status), "/new"))
            self.processor.process_pending()
            self.post(self.payload("draft-" + str(status), "my details"))
            self.processor.process_pending()
            handler.return_value = {"http_status": status, "error": "rejected"}
            self.post(self.payload("confirm-" + str(status), "confirm"))
            self.processor.process_pending()
            self.assertEqual(self.sent.call_args.args[1], ORDER_REVIEW)
            self.assertEqual(self.rows()[-1]["state"], "reconcile" if status == 500 else "failed")
            session = self.rows("messenger_sessions")[0]
            self.assertEqual(bool(session["confirmed"]), status == 500)
            self.assertIsNone(session["pending"])
        self.assertEqual(handler.call_count, 3)

    def test_wrong_order_id_or_missing_acknowledgment_requires_review(self):
        self.model.side_effect = self.chat_orders
        handler = Mock(side_effect=lambda order: {**self.acknowledged(order), "order_id": "other-order"})
        self.processor.order_handler = handler
        self.post(self.payload("draft", "my details"))
        self.processor.process_pending()
        self.post(self.payload("confirm", "confirm"))
        self.processor.process_pending()
        self.assertEqual(self.sent.call_args.args[1], ORDER_REVIEW)
        self.assertEqual(self.rows()[-1]["state"], "reconcile")
        self.assertTrue(self.rows("messenger_sessions")[0]["confirmed"])

    def test_acknowledged_partial_failure_remains_captured(self):
        self.model.side_effect = self.chat_orders
        handler = Mock(side_effect=lambda order: self.acknowledged(order, "failed", "partial_failure", 502))
        self.processor.order_handler = handler
        self.post(self.payload("draft", "my details"))
        self.processor.process_pending()
        self.post(self.payload("confirm", "confirm"))
        self.processor.process_pending()
        self.assertEqual(self.sent.call_count, 1)
        self.assertEqual(self.rows()[-1]["state"], "failed")
        self.assertTrue(self.rows("messenger_sessions")[0]["confirmed"])

    def test_ambiguous_confirmation_effect_is_not_sent_again(self):
        self.model.side_effect = self.chat_orders
        handler = Mock(side_effect=lambda order: self.acknowledged(order, "unknown", "reconcile_required", 202))
        self.processor.order_handler = handler
        self.post(self.payload("draft", "my details"))
        self.processor.process_pending()
        self.post(self.payload("confirm", "confirm"))
        self.processor.process_pending()
        self.assertEqual(self.sent.call_count, 1)
        self.assertEqual(self.rows()[-1]["state"], "reconcile")

    def test_banglish_and_bangla_reviews_and_receipts_match_customer(self):
        self.model.side_effect = self.chat_orders
        self.processor.order_handler = lambda order: self.acknowledged(order)
        self.post(self.payload("banglish-draft", "bhaiya amar details dilam"))
        self.processor.process_pending()
        self.assertIn("Apnar order-er details", self.sent.call_args.args[1])
        self.post(self.payload("banglish-confirm", "confirm"))
        self.processor.process_pending()
        self.assertIn("receive kora hoyeche", self.sent.call_args.args[1])
        self.post(self.payload("new", "/new"))
        self.processor.process_pending()
        self.post(self.payload("bangla-draft", "আমার অর্ডারের তথ্য"))
        self.processor.process_pending()
        self.assertIn("অর্ডারের তথ্য যাচাই করুন", self.sent.call_args.args[1])
        self.post(self.payload("bangla-confirm", "confirm"))
        self.processor.process_pending()
        self.assertIn("গ্রহণ করা হয়েছে", self.sent.call_args.args[1])

    def test_postback_without_optional_mid_has_stable_deduplication(self):
        payload = self.payload()
        event = payload["entry"][0]["messaging"][0]
        del event["message"]
        event["postback"] = {"payload": "SHOW_PRODUCTS", "title": "Products"}
        self.post(payload)
        self.post(payload)
        self.processor.process_pending()
        self.assertEqual(self.model.call_count, 1)
        self.assertEqual(self.model.call_args.args[2], "SHOW_PRODUCTS")

    def test_no_silent_graph_api_version_default_and_private_database(self):
        self.app.config.pop("META_GRAPH_VERSION")
        self.sent.side_effect = REAL_SEND_MESSENGER
        with patch("integrations._post_json") as outgoing:
            self.post()
            self.processor.process_pending()
        outgoing.assert_not_called()
        self.assertEqual(self.rows()[0]["state"], "failed")
        for suffix in ("", "-wal", "-shm"):
            path = Path(self.config["MESSENGER_DB_PATH"] + suffix)
            if path.exists():
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_combined_factory_records_validated_order_without_fulfillment_network(self):
        from app import create_app

        self.model.side_effect = self.chat_orders
        config = {**self.config, "WEBHOOK_SECRET": "internal-only-test-secret", "ORDER_DB_PATH": str(Path(self.temp.name) / "orders.sqlite3")}
        service = create_app(config)
        processor = service.extensions["messenger_processor"]
        self.addCleanup(processor.close)
        client = service.test_client()
        with patch("integrations.deliver_courier") as courier, patch("integrations.append_sheet") as sheet, patch("integrations.send_confirmation") as order_confirmation:
            self.assertEqual(self.post(self.payload("draft", "my details"), client=client).status_code, 200)
            processor.process_pending()
            self.assertEqual(self.post(self.payload("confirm", "confirm"), client=client).status_code, 200)
            processor.process_pending()
        courier.assert_not_called()
        sheet.assert_not_called()
        order_confirmation.assert_not_called()
        event = self.rows()[-1]
        dispatch = json.loads(event["dispatch"])
        self.assertEqual(dispatch["http_status"], 200)
        self.assertEqual(dispatch["status"], "dry_run")
        self.assertEqual(len(dispatch["effects"]), 4)
        self.assertTrue(all(effect["state"] == "planned" for effect in dispatch["effects"].values()))
        self.assertEqual(dispatch["order_id"], json.loads(event["order_json"])["order_id"])
        response = client.get("/webhooks/orders/" + dispatch["order_id"], headers={"Authorization": "Bearer internal-only-test-secret"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["status"], "dry_run")
        self.assertEqual(self.sent.call_count, 2)

    def test_live_failed_confirmation_has_no_fallback_before_order_retry(self):
        from app import create_app

        self.model.side_effect = self.chat_orders
        config = {**self.config, "WEBHOOK_SECRET": "internal-only-test-secret", "ORDER_DB_PATH": str(Path(self.temp.name) / "orders.sqlite3"), "DELIVERY_MODE": "live"}
        service = create_app(config)
        processor = service.extensions["messenger_processor"]
        self.addCleanup(processor.close)
        client = service.test_client()
        with patch("integrations.deliver_courier", return_value={"consignment_id": "mock-shipment"}) as courier, patch("integrations.append_sheet", return_value={"row_saved": True}) as sheet, patch("integrations.send_confirmation", side_effect=[integrations.IntegrationError("http_429"), {"message_id": "mock-retry-confirmation"}]) as order_confirmation:
            self.post(self.payload("draft", "my details"), client=client)
            processor.process_pending()
            self.post(self.payload("confirm", "confirm"), client=client)
            processor.process_pending()
            event = self.rows()[-1]
            self.assertEqual(event["state"], "failed")
            self.assertEqual(json.loads(event["dispatch"])["http_status"], 502)
            # Only the draft used the chat worker's ordinary send path.
            self.assertEqual(self.sent.call_count, 1)
            order_confirmation.assert_called_once()
            order = json.loads(event["order_json"])
            retried = client.post("/webhooks/orders", json=order, headers={"Authorization": "Bearer internal-only-test-secret"})
            self.assertEqual(retried.status_code, 200)
            self.assertEqual(retried.json["effects"]["confirmation_messenger"]["state"], "succeeded")
            self.assertEqual(order_confirmation.call_count, 2)
            self.assertEqual(self.sent.call_count, 1)
            courier.assert_called_once()
            sheet.assert_called_once()


if __name__ == "__main__":
    unittest.main()
