"""Exercise authentication, order effects, replay safety and API boundaries."""

import copy
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import integrations
from orders import load_catalog
from webhook import create_app


def sample_order():
    product = next(item for item in load_catalog().values() if item["stock_status"] == "IN_STOCK")
    price = product["regular_price_bdt"]
    return {
        "order_event": "ORDER_CONFIRMED",
        "order_id": "test-order-001",
        "customer": {
            "full_name": "Demo Customer", "phone_number": "01700000000",
            "address_line": "House 12, Road 4, Sector 3, Uttara", "thana": "Uttara",
            "district": "Dhaka", "zone": "INSIDE_DHAKA",
        },
        "items": [{"product_id": product["product_id"], "quantity": 1, "unit_price_bdt": price}],
        "pricing_summary": {"subtotal_bdt": price, "discount_applied_bdt": 0, "delivery_charge_bdt": 70, "grand_total_bdt": price + 70},
        "logistics": {"courier_partner": "STEADFAST", "payment_method": "CASH_ON_DELIVERY"},
    }


class WebhookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = {"TESTING": True, "WEBHOOK_SECRET": "test-only-secret", "ORDER_DB_PATH": str(Path(self.temp.name) / "orders.sqlite3"), "DELIVERY_MODE": "dry_run"}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.headers = {"Authorization": "Bearer test-only-secret"}
        self.order = sample_order()

    def post(self, payload=None, client=None, path="/webhooks/orders"):
        return (client or self.client).post(path, json=self.order if payload is None else payload, headers=self.headers)

    def live(self):
        self.app.config["DELIVERY_MODE"] = "live"

    def adapters(self, courier=None, sheet=None, messenger=None, tracking=None):
        patches = [
            patch("integrations.deliver_courier", return_value=courier or {"consignment_id": "ship-123", "tracking_code": "tracking-123"}),
            patch("integrations.append_sheet", return_value=sheet or {"row_saved": True}),
            patch("integrations.send_confirmation", return_value=messenger or {"message_id": "msg-123"}),
            patch("integrations.send_tracking", return_value=tracking or {"message_id": "track-msg-123"}),
        ]
        mocks = [item.start() for item in patches]
        for item in patches:
            self.addCleanup(item.stop)
        return mocks

    def test_secret_is_mandatory_and_health_does_not_expose_it(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "WEBHOOK_SECRET"):
                create_app({"ORDER_DB_PATH": self.config["ORDER_DB_PATH"]})
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("test-only-secret", response.get_data(as_text=True))

    def test_authentication_before_validation_or_effect(self):
        mocks = self.adapters()
        for header in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "test-only-secret"}):
            response = self.client.post("/webhooks/orders", json=self.order, headers=header)
            self.assertEqual(response.status_code, 401)
        for mock in mocks:
            mock.assert_not_called()

    def test_dry_run_is_validated_and_never_calls_network(self):
        mocks = self.adapters()
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["status"], "dry_run")
        self.assertTrue(all(item["state"] == "planned" for item in response.json["effects"].values()))
        for mock in mocks:
            mock.assert_not_called()
        for sensitive in ("Demo Customer", "01700000000", "House 12"):
            self.assertNotIn(sensitive, response.get_data(as_text=True))

    def test_bad_event_bad_phone_and_over_discount_cannot_create_order(self):
        mocks = self.adapters()
        for change in ("event", "phone", "discount", "total"):
            order = copy.deepcopy(self.order)
            if change == "event":
                order["order_event"] = "ORDER_DRAFT"
            elif change == "phone":
                order["customer"]["phone_number"] = "01200000000"
            elif change == "discount":
                order["pricing_summary"]["discount_applied_bdt"] = order["pricing_summary"]["subtotal_bdt"] // 5
                order["pricing_summary"]["grand_total_bdt"] -= order["pricing_summary"]["discount_applied_bdt"]
            else:
                order["pricing_summary"]["grand_total_bdt"] += 1
            self.assertEqual(self.post(order).status_code, 400)
        self.assertEqual(self.client.get("/webhooks/orders/" + self.order["order_id"], headers=self.headers).status_code, 404)
        for mock in mocks:
            mock.assert_not_called()

    def test_duplicate_persists_across_restart_and_changed_payload_conflicts(self):
        self.live()
        mocks = self.adapters()
        self.assertEqual(self.post().status_code, 200)
        restarted = create_app({**self.config, "DELIVERY_MODE": "live"})
        self.assertEqual(self.post(client=restarted.test_client()).status_code, 200)
        for mock in mocks:
            self.assertEqual(mock.call_count, 1)
        changed = copy.deepcopy(self.order)
        changed["customer"]["address_line"] = "House 13, Road 4, Sector 3, Uttara"
        self.assertEqual(self.post(changed).status_code, 409)
        changed = copy.deepcopy(self.order)
        changed["courier_metadata"] = {"recipient_city": 1}
        self.assertEqual(self.post(changed).status_code, 409)

    def test_dry_run_id_cannot_be_silently_reused_live(self):
        self.assertEqual(self.post().status_code, 200)
        self.live()
        self.assertEqual(self.post().status_code, 409)

    def test_sheet_failure_retry_does_not_repeat_courier_or_messages(self):
        self.live()
        courier, sheet, message, tracking = self.adapters()
        sheet.side_effect = [integrations.IntegrationError("http_401"), {"row_saved": True}]
        first = self.post()
        self.assertEqual(first.status_code, 502)
        self.assertEqual(first.json["effects"]["sheets"]["state"], "failed")
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(sheet.call_count, 2)
        self.assertEqual(courier.call_count, 1)
        self.assertEqual(message.call_count, 1)
        self.assertEqual(tracking.call_count, 1)

    def test_saved_replay_survives_catalog_inventory_changes(self):
        self.live()
        courier, sheet, message, tracking = self.adapters()
        sheet.side_effect = [integrations.IntegrationError("http_401"), {"row_saved": True}]
        self.assertEqual(self.post().status_code, 502)
        with patch("orders.load_catalog", side_effect=AssertionError("An accepted identical replay must not read current stock")):
            self.assertEqual(self.post().status_code, 200)
        self.assertEqual(courier.call_count, 1)
        self.assertEqual(sheet.call_count, 2)
        self.assertEqual(message.call_count, 1)
        self.assertEqual(tracking.call_count, 1)

    def test_ambiguous_courier_timeout_never_retries(self):
        self.live()
        courier, sheet, message, tracking = self.adapters()
        courier.side_effect = integrations.IntegrationError("transport_error", ambiguous=True)
        first = self.post()
        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.json["status"], "reconcile_required")
        self.assertEqual(self.post().status_code, 202)
        self.assertEqual(courier.call_count, 1)
        self.assertEqual(sheet.call_count, 1)
        self.assertEqual(message.call_count, 1)
        tracking.assert_not_called()

    def test_inflight_courier_is_not_rebooked_by_concurrent_request(self):
        self.live()
        courier, sheet, message, tracking = self.adapters()
        entered, release = threading.Event(), threading.Event()
        responses = []

        def booking(*_args):
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test synchronization failed")
            return {"consignment_id": "ship-123", "tracking_code": "tracking-123"}

        courier.side_effect = booking

        def first_request():
            with self.app.test_client() as client:
                responses.append(self.post(client=client))

        thread = threading.Thread(target=first_request)
        thread.start()
        self.assertTrue(entered.wait(5))
        try:
            duplicate = self.post()
            self.assertEqual(duplicate.status_code, 202)
            self.assertEqual(courier.call_count, 1)
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(responses[0].status_code, 200)
        self.assertEqual(sheet.call_count, 1)
        self.assertEqual(message.call_count, 1)
        self.assertEqual(tracking.call_count, 1)

    def test_stale_in_progress_is_reported_for_reconciliation_without_retry(self):
        self.live()
        courier, *_rest = self.adapters()
        self.assertEqual(self.post().status_code, 200)
        with sqlite3.connect(self.config["ORDER_DB_PATH"]) as connection:
            connection.execute("UPDATE effects SET state = 'in_progress', updated_at = 0 WHERE name = 'courier'")
        response = self.post()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json["status"], "reconcile_required")
        self.assertEqual(courier.call_count, 1)

    def test_tracking_callback_is_authenticated_deduplicated_and_no_sms(self):
        self.live()
        _courier, _sheet, _message, tracking = self.adapters()
        self.post()
        payload = {"order_event": "TRACKING_UPDATED", "order_id": self.order["order_id"], "tracking_code": "track-123", "status": "in_transit"}
        self.assertEqual(self.client.post("/webhooks/tracking", json=payload).status_code, 401)
        first = self.post(payload, path="/webhooks/tracking")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.post(payload, path="/webhooks/tracking").status_code, 200)
        self.assertEqual(tracking.call_count, 2)  # Booking alert and this new event.
        self.assertNotIn("sms_sent", first.get_data(as_text=True))
        state = self.client.get("/webhooks/orders/" + self.order["order_id"], headers=self.headers)
        self.assertEqual(state.status_code, 200)
        self.assertNotIn(self.order["customer"]["phone_number"], state.get_data(as_text=True))


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.order = sample_order()

    def test_steadfast_payload_matches_official_fields(self):
        config = {"STEADFAST_API_KEY": "key", "STEADFAST_SECRET_KEY": "secret"}
        with patch("integrations._post_json", return_value={"status": 200, "consignment": {"consignment_id": 123, "tracking_code": "ABC"}}) as post:
            result = integrations.deliver_courier(self.order, config)
        self.assertEqual(result["consignment_id"], "123")
        url, payload, headers = post.call_args.args
        self.assertEqual(url, "https://portal.steadfast.com.bd/api/v1/create_order")
        self.assertEqual(payload["invoice"], self.order["order_id"])
        self.assertEqual(payload["cod_amount"], self.order["pricing_summary"]["grand_total_bdt"])
        self.assertEqual(headers, {"Api-Key": "key", "Secret-Key": "secret"})

    def test_pathao_needs_real_routes_and_weight_before_network(self):
        self.order["logistics"]["courier_partner"] = "PATHAO"
        config = {"PATHAO_STORE_ID": "1", "PATHAO_CLIENT_ID": "id", "PATHAO_CLIENT_SECRET": "secret"}
        with patch("integrations._post_json") as post:
            with self.assertRaises(integrations.IntegrationError):
                integrations.deliver_courier(self.order, config)
            post.assert_not_called()
        self.order["courier_metadata"] = {"recipient_city": 1, "recipient_zone": 2, "recipient_area": 3, "item_weight_kg": 0.5}
        with patch("integrations._post_json", side_effect=[{"access_token": "token"}, {"data": {"consignment_id": "P123"}}]) as post:
            integrations.deliver_courier(self.order, config)
        login, creation = post.call_args_list
        self.assertTrue(login.args[0].endswith("/aladdin/api/v1/external/login"))
        self.assertEqual(login.args[1], {"client_id": "id", "client_secret": "secret"})
        self.assertEqual(creation.args[1]["recipient_area"], 3)
        self.assertEqual(creation.args[1]["item_weight"], 0.5)

    def test_redx_is_unsupported_and_cannot_fallback(self):
        self.order["logistics"]["courier_partner"] = "REDX"
        with patch("integrations._post_json") as post:
            with self.assertRaisesRegex(integrations.IntegrationError, "unsupported_courier"):
                integrations.deliver_courier(self.order, {})
            post.assert_not_called()

    def test_sheets_raw_append_and_hook_only_reports_forwarded(self):
        with patch("integrations._post_json", return_value={"updates": {"updatedRows": 1}}) as post:
            result = integrations.append_sheet(self.order, {"GOOGLE_SHEETS_SPREADSHEET_ID": "sheet-id", "GOOGLE_SHEETS_ACCESS_TOKEN": "token"})
        self.assertTrue(result["row_saved"])
        self.assertIn("valueInputOption=RAW", post.call_args.args[0])
        self.assertEqual(post.call_args.args[1]["values"][0][1], "01700000000")
        with patch("integrations._post_json", return_value={}) as post:
            result = integrations.append_sheet(self.order, {"SHEETS_WEBHOOK_URL": "https://hooks.example.test/orders"})
        self.assertFalse(result["row_saved"])
        self.assertEqual(post.call_args.args[1]["full_name"], "Demo Customer")

    def test_sheets_service_account_refreshes_token_before_append(self):
        credentials = Mock(token="refreshed-token")
        with patch("google.oauth2.service_account.Credentials.from_service_account_file", return_value=credentials) as read_key, patch("google.auth.transport.requests.Request") as transport, patch("integrations._post_json", return_value={"updates": {"updatedRows": 1}}) as post:
            result = integrations.append_sheet(self.order, {"GOOGLE_SHEETS_SPREADSHEET_ID": "sheet-id", "GOOGLE_SHEETS_SERVICE_ACCOUNT_FILE": "/configured/private-service-account.json"})
        self.assertTrue(result["row_saved"])
        read_key.assert_called_once_with("/configured/private-service-account.json", scopes=["https://www.googleapis.com/auth/spreadsheets"])
        credentials.refresh.assert_called_once_with(transport.return_value)
        self.assertEqual(post.call_args.args[2]["Authorization"], "Bearer refreshed-token")

    def test_malformed_sheet_success_is_unknown_and_not_claimed_saved(self):
        with patch("integrations._post_json", return_value={"updates": "invalid"}):
            with self.assertRaises(integrations.IntegrationError) as caught:
                integrations.append_sheet(self.order, {"GOOGLE_SHEETS_SPREADSHEET_ID": "sheet-id", "GOOGLE_SHEETS_ACCESS_TOKEN": "token"})
        self.assertTrue(caught.exception.ambiguous)

    def test_messenger_requires_trusted_psid_and_recent_interaction(self):
        config = {"META_PAGE_ID": "123", "META_PAGE_ACCESS_TOKEN": "token", "META_GRAPH_VERSION": "v24.0"}
        with patch("integrations._post_json") as post:
            self.assertIn("skipped", integrations.send_confirmation(self.order, config))
            post.assert_not_called()
        self.order["messenger_psid"] = "456"
        self.order["messenger_last_interaction_at"] = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
        with patch("integrations._post_json") as post:
            self.assertEqual(integrations.send_confirmation(self.order, config)["skipped"], "outside_messenger_response_window")
            post.assert_not_called()
        self.order["messenger_last_interaction_at"] = datetime.now(timezone.utc).isoformat()
        with patch("integrations._post_json", return_value={"message_id": "mid", "recipient_id": "456"}) as post:
            self.assertEqual(integrations.send_confirmation(self.order, config)["message_id"], "mid")
        self.assertEqual(post.call_args.args[1]["messaging_type"], "RESPONSE")
        self.assertNotIn("tag", post.call_args.args[1])
        with patch("integrations._post_json", return_value={"message_id": "mid", "recipient_id": "wrong"}):
            with self.assertRaises(integrations.IntegrationError) as caught:
                integrations.send_confirmation(self.order, config)
            self.assertTrue(caught.exception.ambiguous)

    def test_http_timeout_server_error_and_redirect_are_ambiguous(self):
        for error in (URLError("timeout"), HTTPError("https://example.test", 408, "request timeout", {}, BytesIO()), HTTPError("https://example.test", 503, "server error", {}, BytesIO()), HTTPError("https://example.test", 302, "redirect", {}, BytesIO())):
            opener = Mock()
            opener.open.side_effect = error
            with patch("integrations.build_opener", return_value=opener) as factory:
                with self.assertRaises(integrations.IntegrationError) as caught:
                    integrations._post_json("https://example.test", {})
                self.assertTrue(caught.exception.ambiguous)
                self.assertIsInstance(factory.call_args.args[0], integrations._NoRedirect)
        opener = Mock()
        opener.open.side_effect = HTTPError("https://example.test", 401, "unauthorized", {}, BytesIO())
        with patch("integrations.build_opener", return_value=opener):
            with self.assertRaises(integrations.IntegrationError) as caught:
                integrations._post_json("https://example.test", {})
            self.assertFalse(caught.exception.ambiguous)


if __name__ == "__main__":
    unittest.main()
