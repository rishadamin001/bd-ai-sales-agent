"""The dispatch boundary must not disclose orders or tokens over remote HTTP."""

import os
import unittest
from unittest.mock import patch

from app import dispatch_order


class DispatchUrlTests(unittest.TestCase):
    def test_plain_http_userinfo_and_bad_ports_fail_before_network(self):
        urls = [
            "http://127.0.0.1:5000@attacker.example/webhooks/orders",
            "http://attacker.example/webhooks/orders",
            "https://user:password@merchant.example/webhooks/orders",
            "http://localhost:99999/webhooks/orders",
            "http://localhost:bad/webhooks/orders",
            "ftp://localhost/webhooks/orders",
            "https:///webhooks/orders",
        ]
        with patch("app.request.build_opener") as opener:
            for url in urls:
                with self.subTest(url=url), patch.dict(os.environ, {"ORDER_WEBHOOK_URL": url, "WEBHOOK_SECRET": "test-secret"}):
                    with self.assertRaises(ValueError):
                        dispatch_order({})
            opener.assert_not_called()


if __name__ == "__main__":
    unittest.main()
