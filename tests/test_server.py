"""Deployment entrypoint and authentication boundaries for the combined server."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from app import create_app, main


class CombinedServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = {
            "WEBHOOK_SECRET": "test-order-secret", "FB_APP_SECRET": "test-app-secret",
            "FB_VERIFY_TOKEN": "test-verification-token", "FB_PAGE_ID": "123456",
            "FB_PAGE_ACCESS_TOKEN": "fake-page-token", "META_GRAPH_VERSION": "v24.0",
            "ORDER_DB_PATH": str(Path(self.temp.name) / "orders.sqlite3"),
            "MESSENGER_DB_PATH": str(Path(self.temp.name) / "messenger.sqlite3"),
            "MESSENGER_BACKGROUND_WORKER": False, "DELIVERY_MODE": "dry_run",
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_meta_verification_is_separate_from_order_bearer_auth(self):
        server = create_app(self.config)
        self.addCleanup(server.extensions["messenger_processor"].close)
        client = server.test_client()
        response = client.get("/webhook", query_string={
            "hub.mode": "subscribe", "hub.verify_token": "test-verification-token", "hub.challenge": "render-check",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "render-check")
        self.assertEqual(client.post("/webhook", json={}).status_code, 403)
        self.assertEqual(client.post("/webhooks/orders", json={}).status_code, 401)
        self.assertEqual(client.get("/health").status_code, 200)
        self.assertEqual(server.config["META_PAGE_ID"], "123456")
        self.assertEqual(server.config["META_PAGE_ACCESS_TOKEN"], "fake-page-token")

    def test_render_live_fulfillment_rejects_ephemeral_state(self):
        with self.assertRaisesRegex(RuntimeError, "durable state"):
            create_app({**self.config, "RENDER": "true", "DELIVERY_MODE": "live", "FULFILLMENT_STATE_DURABLE": "false"})

    def test_direct_server_uses_cloud_port_and_all_interfaces(self):
        with patch.dict(os.environ, {"PORT": "18080"}), patch("app.app.run") as run:
            self.assertEqual(main(["--serve"]), 0)
        run.assert_called_once_with(host="0.0.0.0", port=18080)


if __name__ == "__main__":
    unittest.main()
