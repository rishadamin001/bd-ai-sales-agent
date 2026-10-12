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

    def test_verification_returns_plain_text_for_exact_configured_token(self):
        server = create_app(self.config)
        self.addCleanup(server.extensions["messenger_processor"].close)
        client = server.test_client()
        response = client.get("/webhook", query_string={
            "hub.mode": "subscribe", "hub.verify_token": "test-verification-token", "hub.challenge": "12345",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "12345")
        self.assertEqual(response.mimetype, "text/plain")
        for token in ("wrong", "test-verification-token ", ""):
            with self.subTest(token=token):
                self.assertEqual(client.get("/webhook", query_string={
                    "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "12345",
                }).status_code, 403)

    def test_missing_query_parameters_and_wrong_mode_return_403(self):
        server = create_app(self.config)
        self.addCleanup(server.extensions["messenger_processor"].close)
        client = server.test_client()
        cases = ({}, {"hub.mode": "subscribe"}, {"hub.verify_token": "test-verification-token"},
                 {"hub.mode": "invalid", "hub.verify_token": "test-verification-token"})
        for query in cases:
            with self.subTest(query=query):
                response = client.get("/webhook", query_string=query)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.text, "Verification failed")

    def test_default_token_is_used_when_environment_and_config_omit_it(self):
        config = {key: value for key, value in self.config.items() if key != "FB_VERIFY_TOKEN"}
        with patch.dict(os.environ):
            os.environ.pop("FB_VERIFY_TOKEN", None)
            server = create_app(config)
            self.addCleanup(server.extensions["messenger_processor"].close)
            response = server.test_client().get("/webhook", query_string={
                "hub.mode": "subscribe", "hub.verify_token": "my_custom_secret_verify_token_123", "hub.challenge": "fallback",
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "fallback")

    def test_environment_token_overrides_the_default(self):
        config = {key: value for key, value in self.config.items() if key != "FB_VERIFY_TOKEN"}
        with patch.dict(os.environ, {"FB_VERIFY_TOKEN": "environment-token"}):
            server = create_app(config)
            self.addCleanup(server.extensions["messenger_processor"].close)
            client = server.test_client()
            response = client.get("/webhook", query_string={
                "hub.mode": "subscribe", "hub.verify_token": "environment-token", "hub.challenge": "env",
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, "env")
            self.assertEqual(client.get("/webhook", query_string={
                "hub.mode": "subscribe", "hub.verify_token": "my_custom_secret_verify_token_123", "hub.challenge": "env",
            }).status_code, 403)

    def test_missing_and_empty_challenge_are_stringified_without_crashing(self):
        server = create_app(self.config)
        self.addCleanup(server.extensions["messenger_processor"].close)
        client = server.test_client()
        for challenge, expected in ((None, "None"), ("", ""), ("চ্যালেঞ্জ", "চ্যালেঞ্জ")):
            with self.subTest(challenge=challenge):
                query = {"hub.mode": "subscribe", "hub.verify_token": "test-verification-token"}
                if challenge is not None:
                    query["hub.challenge"] = challenge
                response = client.get("/webhook", query_string=query)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.text, expected)

    def test_explicit_empty_environment_token_preserves_getenv_semantics(self):
        config = {key: value for key, value in self.config.items() if key != "FB_VERIFY_TOKEN"}
        with patch.dict(os.environ, {"FB_VERIFY_TOKEN": ""}):
            server = create_app(config)
            self.addCleanup(server.extensions["messenger_processor"].close)
            client = server.test_client()
            self.assertEqual(client.get("/webhook", query_string={"hub.mode": "subscribe"}).status_code, 403)
            response = client.get("/webhook", query_string={"hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "empty"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text, "empty")

    def test_direct_server_uses_cloud_port_and_all_interfaces(self):
        with patch.dict(os.environ, {"PORT": "18080"}), patch("app.app.run") as run:
            self.assertEqual(main(["--serve"]), 0)
        run.assert_called_once_with(host="0.0.0.0", port=18080)


if __name__ == "__main__":
    unittest.main()
