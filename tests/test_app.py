"""Behavioral tests for the quote/consent boundary; no Gemini or network calls."""

from __future__ import annotations

import copy
import io
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app
from orders import OrderValidationError, load_catalog


def sample_order(event: str = "ORDER_DRAFT") -> dict:
    product = next(item for item in load_catalog().values() if item["stock_status"] == "IN_STOCK")
    price = product["regular_price_bdt"]
    return {
        "order_event": event,
        "order_id": "AURA-test-order",
        "items": [{"product_id": product["product_id"], "quantity": 1, "unit_price_bdt": price}],
        "customer": {
            "full_name": "Arafat",
            "phone_number": "01700000000",
            "address_line": "House 12, Road 4, Sector 3, Uttara",
            "thana": "Uttara",
            "district": "Dhaka",
            "zone": "INSIDE_DHAKA",
        },
        "pricing_summary": {
            "subtotal_bdt": price,
            "discount_applied_bdt": 0,
            "delivery_charge_bdt": 70,
            "grand_total_bdt": price + 70,
        },
        "logistics": {"courier_partner": "STEADFAST", "payment_method": "CASH_ON_DELIVERY"},
    }


def response_text(order: dict) -> str:
    return "Please review these details.\n\n```json\n" + json.dumps(order) + "\n```"


class ConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.draft = sample_order()
        self.state = app.OrderState(self.draft["order_id"])

    def quote(self):
        rendered, event = app.process_response(response_text(self.draft), "Here are my details", self.state)
        self.assertIsNone(event)
        self.assertIn(str(self.draft["pricing_summary"]["grand_total_bdt"]), rendered)
        return rendered

    def confirmed_payload(self):
        confirmed = copy.deepcopy(self.draft)
        confirmed["order_event"] = "ORDER_CONFIRMED"
        return confirmed

    def test_exact_confirmation_phrases_and_negations(self):
        for message in ("confirm", "YES CONFIRM!", "Ha confirm koren", "কনফার্ম করুন।"):
            with self.subTest(message=message):
                self.assertTrue(app.explicit_confirmation(message))
        for message in ("don't confirm", "no", "yes but change the address", "confirm at 500 taka", "how to confirm?", ""):
            with self.subTest(message=message):
                self.assertFalse(app.explicit_confirmation(message))

    def test_complete_review_then_explicit_confirmation_returns_order(self):
        self.quote()
        _, order = app.process_response(response_text(self.confirmed_payload()), "Ha confirm koren", self.state)
        self.assertEqual(order["order_event"], "ORDER_CONFIRMED")
        self.assertEqual(order["order_id"], self.state.order_id)
        self.assertTrue(self.state.confirmed)
        self.assertIsNone(self.state.pending)

    def test_no_previous_quote_cannot_be_confirmed(self):
        with self.assertRaisesRegex(OrderValidationError, "complete quote"):
            app.process_response(response_text(self.confirmed_payload()), "confirm", self.state)
        self.assertFalse(self.state.confirmed)
        self.assertIsNone(self.state.pending)

    def test_changed_valid_quote_requires_new_review(self):
        self.quote()
        changed = self.confirmed_payload()
        changed["customer"]["address_line"] = "House 13, Road 4, Sector 3, Uttara"
        with self.assertRaisesRegex(OrderValidationError, "changed after its quote"):
            app.process_response(response_text(changed), "confirm", self.state)
        self.assertIsNone(self.state.pending)
        self.assertFalse(self.state.confirmed)

    def test_nonconfirmation_cannot_dispatch_model_confirmed_order(self):
        self.quote()
        with self.assertRaisesRegex(OrderValidationError, "explicit confirmation"):
            app.process_response(response_text(self.confirmed_payload()), "what is the return policy?", self.state)
        self.assertFalse(self.state.confirmed)
        self.assertIsNone(self.state.pending)

    def test_model_cannot_supply_merchant_integration_settings(self):
        forbidden = {
            "courier_metadata": {"recipient_city": 1},
            "messenger_psid": "123456789",
            "messenger_last_interaction_at": "2026-10-13T00:00:00+00:00",
            "confirmation_message": "Sent successfully",
        }
        for field, value in forbidden.items():
            with self.subTest(field=field):
                self.state = app.OrderState(self.draft["order_id"])
                self.quote()
                payload = self.confirmed_payload()
                payload[field] = value
                with self.assertRaisesRegex(OrderValidationError, "merchant-only"):
                    app.process_response(response_text(payload), "confirm", self.state)
                self.assertIsNone(self.state.pending)
                self.assertFalse(self.state.confirmed)

    def test_model_cannot_self_verify_remote_area(self):
        payload = copy.deepcopy(self.draft)
        payload["customer"].update({
            "address_line": "Village Shantipur, near Central Market, Union Example",
            "thana": "Rajshahi Sadar",
            "district": "Rajshahi",
            "zone": "OUTSIDE_DHAKA",
            "remote_area": True,
        })
        payload["pricing_summary"]["delivery_charge_bdt"] = 150
        payload["pricing_summary"]["grand_total_bdt"] = payload["pricing_summary"]["subtotal_bdt"] + 150
        with self.assertRaises(OrderValidationError):
            app.process_response(response_text(payload), "Here is my address", self.state)
        self.assertIsNone(self.state.pending)

    def test_duplicate_confirmation_does_not_return_dispatchable_order(self):
        self.quote()
        confirmed = self.confirmed_payload()
        app.process_response(response_text(confirmed), "confirm", self.state)
        rendered, order = app.process_response(response_text(confirmed), "confirm", self.state)
        self.assertIsNone(order)
        self.assertIn("already been captured", rendered)

    def test_customer_amendment_invalidates_pending_quote(self):
        self.quote()
        _, event = app.process_response("Please provide the revised address.", "change my delivery address", self.state)
        self.assertIsNone(event)
        self.assertIsNone(self.state.pending)
        with self.assertRaises(OrderValidationError):
            app.process_response(response_text(self.confirmed_payload()), "confirm", self.state)

    def test_order_id_mismatch_invalidates_quote(self):
        self.quote()
        changed = self.confirmed_payload()
        changed["order_id"] = "AURA-other-session"
        with self.assertRaisesRegex(OrderValidationError, "Order ID"):
            app.process_response(response_text(changed), "confirm", self.state)
        self.assertIsNone(self.state.pending)

    def test_system_instructions_load_all_three_merchant_documents(self):
        instructions = app.system_instructions("AURA-load-test")
        for filename in ("SYSTEM_PROMPT.md", "DELIVERY_RATES.md", "PRODUCT_CATALOG.md"):
            with self.subTest(filename=filename):
                self.assertIn(f"# Merchant document: {filename}", instructions)
                self.assertIn((ROOT / filename).read_text(encoding="utf-8"), instructions)
        self.assertIn("Use order_id AURA-load-test", instructions)


class CliDispatchTests(unittest.TestCase):
    def run_fake_chat(self, messages: list[str], payloads: list[dict]):
        for payload in payloads:
            payload["order_id"] = "AURA-fixed-session"
        chat = Mock()
        chat.send_message.side_effect = [types.SimpleNamespace(text=response_text(payload)) for payload in payloads]
        client = Mock()
        client.chats.create.return_value = chat
        genai = types.ModuleType("google.genai")
        genai.Client = Mock(return_value=client)
        genai_types = types.ModuleType("google.genai.types")
        genai_types.GenerateContentConfig = lambda **kwargs: types.SimpleNamespace(**kwargs)
        genai.types = genai_types
        google = types.ModuleType("google")
        google.genai = genai
        modules = {"google": google, "google.genai": genai, "google.genai.types": genai_types}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {"GEMINI_API_KEY": "test-api-key", "WEBHOOK_SECRET": "test-secret"}), patch.object(app, "load_env"), patch.object(app.uuid, "uuid4", return_value=types.SimpleNamespace(hex="fixed-session")), patch("builtins.input", side_effect=[*messages, "/quit"]), patch.object(app, "dispatch_order", return_value={"accepted": True}) as dispatch, patch("sys.stdout", new_callable=io.StringIO), patch("sys.stderr", new_callable=io.StringIO) as stderr:
            status = app.main(["--dispatch"])
            calls = dispatch.call_args_list
            errors = stderr.getvalue()
        client.close.assert_called_once()
        return status, calls, errors

    def test_draft_is_never_dispatched(self):
        status, calls, _ = self.run_fake_chat(["Here are my details"], [sample_order()])
        self.assertEqual(status, 0)
        self.assertEqual(calls, [])

    def test_confirmed_without_pending_quote_is_never_dispatched(self):
        status, calls, errors = self.run_fake_chat(["confirm"], [sample_order("ORDER_CONFIRMED")])
        self.assertEqual(status, 0)
        self.assertEqual(calls, [])
        self.assertIn("complete quote", errors)

    def test_confirmed_after_review_dispatches_once_despite_duplicate(self):
        confirmed = sample_order("ORDER_CONFIRMED")
        status, calls, _ = self.run_fake_chat(
            ["Here are my details", "confirm", "confirm"],
            [sample_order(), confirmed, copy.deepcopy(confirmed)],
        )
        self.assertEqual(status, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].args[0]["order_event"], "ORDER_CONFIRMED")


if __name__ == "__main__":
    unittest.main()
