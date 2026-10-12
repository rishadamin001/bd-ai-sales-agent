"""Business rule tests independent of Gemini or live courier credentials."""

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import orders


def sample_catalog():
    return {
        "AURA-TEE-001": {
            "item_name": "Aura Cotton T-Shirt", "product_id": "AURA-TEE-001",
            "regular_price_bdt": 1000, "minimum_negotiable_price_bdt": 900,
            "stock_status": "IN_STOCK", "alternative_suggested_item": "AURA-POLO-002",
        },
        "AURA-POLO-002": {
            "item_name": "Aura Polo", "product_id": "AURA-POLO-002",
            "regular_price_bdt": 1500, "minimum_negotiable_price_bdt": 1350,
            "stock_status": "IN_STOCK", "alternative_suggested_item": "AURA-TEE-001",
        },
        "AURA-EARBUDS-003": {
            "item_name": "Aura Earbuds", "product_id": "AURA-EARBUDS-003",
            "regular_price_bdt": 2000, "minimum_negotiable_price_bdt": 1800,
            "stock_status": "IN_STOCK", "alternative_suggested_item": "AURA-TEE-001",
        },
    }


def sample_order():
    return {
        "order_event": "ORDER_CONFIRMED", "order_id": "BD-20261013-001",
        "customer": {
            "full_name": "Arafat", "phone_number": "01700000000",
            "address_line": "House 12, Road 4, Sector 3, Uttara",
            "thana": "Uttara", "district": "Dhaka", "zone": "INSIDE_DHAKA",
        },
        "items": [{"product_id": "AURA-EARBUDS-003", "quantity": 1, "unit_price_bdt": 2000}],
        "pricing_summary": {"subtotal_bdt": 2000, "discount_applied_bdt": 200, "delivery_charge_bdt": 70, "grand_total_bdt": 1870},
        "logistics": {"courier_partner": "STEADFAST", "payment_method": "CASH_ON_DELIVERY"},
    }


class PhoneTests(unittest.TestCase):
    def test_normalizes_local_international_and_bangla_digits(self):
        for number in ("01700000000", "+880 1700-000000", "+880 (1700) 000000", "8801700000000", "০১৭০০০০০০০০", "+৮৮০১৭০০০০০০০০"):
            with self.subTest(number=number):
                self.assertEqual(orders.normalize_phone(number), "01700000000")

    def test_rejects_wrong_prefix_length_and_type(self):
        for number in ("01200000000", "0170000000", "017000000000", "+88001700000000", "01700000000x", 1700000000, None):
            with self.subTest(number=number), self.assertRaises(orders.OrderValidationError):
                orders.normalize_phone(number)


class CatalogTests(unittest.TestCase):
    TABLE = """# Catalog
| Item Name | Product ID | Regular Price (BDT) | Minimum Negotiable Price (10% max discount) | Stock Status | Alternative Suggested Item |
| --- | --- | ---: | ---: | --- | --- |
| Sample Tee | AURA-TEE-001 | ৳1,000 | 900 | IN_STOCK | AURA-POLO-002 |
| Sample Polo | AURA-POLO-002 | ১৫০০ | ১৩৫০ | OUT_OF_STOCK | AURA-TEE-001 |
"""

    def load_text(self, text):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "catalog.md"
            path.write_text(text, encoding="utf-8")
            return orders.load_catalog(path)

    def test_catalog_reads_integer_prices_and_stock(self):
        catalog = self.load_text(self.TABLE)
        self.assertEqual(catalog["AURA-TEE-001"]["regular_price_bdt"], 1000)
        self.assertEqual(catalog["AURA-POLO-002"]["minimum_negotiable_price_bdt"], 1350)
        self.assertEqual(catalog["AURA-POLO-002"]["stock_status"], "OUT_OF_STOCK")

    def test_duplicate_or_invalid_catalog_rows_fail_closed(self):
        for text in (self.TABLE + self.TABLE.splitlines()[3] + "\n", self.TABLE.replace("| 900 |", "| 1100 |"), self.TABLE.replace("IN_STOCK", "MAYBE")):
            with self.subTest(text=text), self.assertRaises(orders.OrderValidationError):
                self.load_text(text)


class OrderTests(unittest.TestCase):
    def setUp(self):
        self.catalog = sample_catalog()
        self.patcher = patch("orders.load_catalog", return_value=self.catalog)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_valid_order_normalizes_without_mutating_input(self):
        payload = sample_order()
        payload["customer"]["phone_number"] = "+880 1700-000000"
        payload["customer"]["district"] = "ঢাকা"
        original = copy.deepcopy(payload)
        canonical = orders.validate_order(payload)
        self.assertEqual(canonical["customer"]["phone_number"], "01700000000")
        self.assertEqual(canonical["customer"]["district"], "Dhaka")
        self.assertEqual(payload, original)

    def test_draft_requires_explicit_opt_in(self):
        payload = sample_order()
        payload["order_event"] = "ORDER_DRAFT"
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(payload)
        self.assertEqual(orders.validate_order(payload, allow_draft=True)["order_event"], "ORDER_DRAFT")

    def test_discount_arithmetic_catalog_and_stock_are_enforced(self):
        mutations = [
            lambda p: p["pricing_summary"].update(discount_applied_bdt=201, grand_total_bdt=1869),
            lambda p: p["pricing_summary"].update(grand_total_bdt=1800),
            lambda p: p["pricing_summary"].update(subtotal_bdt=1500),
            lambda p: p["items"][0].update(unit_price_bdt=1800),
            lambda p: p["items"][0].update(product_id="UNKNOWN"),
            lambda p: p["items"][0].update(quantity=True),
            lambda p: p["items"][0].update(quantity=101),
            lambda p: p["pricing_summary"].update(discount_applied_bdt=True),
        ]
        for mutate in mutations:
            payload = sample_order()
            mutate(payload)
            with self.subTest(payload=payload), self.assertRaises(orders.OrderValidationError):
                orders.validate_order(payload)
        self.catalog["AURA-EARBUDS-003"]["stock_status"] = "OUT_OF_STOCK"
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(sample_order())

    def test_catalog_minimum_can_be_stricter_than_ten_percent(self):
        self.catalog["AURA-EARBUDS-003"]["minimum_negotiable_price_bdt"] = 1900
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(sample_order())

    def test_proportional_discount_honors_each_product_floor(self):
        self.catalog["AURA-EARBUDS-003"]["minimum_negotiable_price_bdt"] = 1900
        payload = sample_order()
        payload["items"].append({"product_id": "AURA-TEE-001", "quantity": 1, "unit_price_bdt": 1000})
        # Aggregate minimum is 2800, but this 6.67% discount would put the
        # earbuds below their stricter 1900 per-unit minimum.
        payload["pricing_summary"].update(subtotal_bdt=3000, discount_applied_bdt=200, grand_total_bdt=2870)
        with self.assertRaisesRegex(orders.OrderValidationError, "Proportional"):
            orders.validate_order(payload)
        payload["pricing_summary"].update(discount_applied_bdt=150, grand_total_bdt=2920)
        orders.validate_order(payload)

    def test_multiple_items_subtotal_uses_quantity_and_no_duplicate_ids(self):
        payload = sample_order()
        payload["items"] = [{"product_id": "AURA-TEE-001", "quantity": 2, "unit_price_bdt": 1000}, {"product_id": "AURA-POLO-002", "quantity": 1, "unit_price_bdt": 1500}]
        payload["pricing_summary"].update(subtotal_bdt=3500, discount_applied_bdt=350, grand_total_bdt=3220)
        orders.validate_order(payload)
        payload["items"].append(payload["items"][0].copy())
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(payload)

    def test_free_delivery_cannot_stack_with_product_discount(self):
        payload = sample_order()
        payload["pricing_summary"].update(delivery_charge_bdt=0, grand_total_bdt=1800)
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(payload)
        payload["pricing_summary"].update(discount_applied_bdt=0, grand_total_bdt=2000)
        orders.validate_order(payload)

    def test_outside_district_cannot_claim_dhaka_zone(self):
        payload = sample_order()
        payload["customer"].update(district="ctg", thana="Panchlaish", address_line="House 12, Road 4, Panchlaish")
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(payload)
        payload["customer"]["zone"] = "OUTSIDE_DHAKA"
        payload["pricing_summary"].update(delivery_charge_bdt=130, grand_total_bdt=1930)
        canonical = orders.validate_order(payload)
        self.assertEqual(canonical["customer"]["district"], "Chattogram")

    def test_suburbs_take_priority_in_latin_and_bangla(self):
        cases = [("Dhaka", "Savar", "House 12, Road 4, Savar"), ("ঢাকা", "কেরানীগঞ্জ", "বাড়ি ১২, রাস্তা ৪, কেরানীগঞ্জ"), ("গাজীপুর", "টঙ্গী", "বাড়ি ১২, রাস্তা ৪, টঙ্গী"), ("Narayanganj", "Fatullah", "House 12, Road 4, Fatullah")]
        for district, thana, address in cases:
            payload = sample_order()
            payload["customer"].update(district=district, thana=thana, address_line=address)
            with self.subTest(district=district), self.assertRaises(orders.OrderValidationError):
                orders.validate_order(payload)
            payload["customer"]["zone"] = "DHAKA_SUBURBS"
            payload["pricing_summary"].update(delivery_charge_bdt=100, grand_total_bdt=1900)
            orders.validate_order(payload)

    def test_outer_dhaka_upazila_is_not_city_delivery(self):
        payload = sample_order()
        payload["customer"].update(thana="Dohar", address_line="Village Joypara, Union Nayabari, Dohar")
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(payload)
        payload["customer"]["zone"] = "OUTSIDE_DHAKA"
        payload["pricing_summary"].update(delivery_charge_bdt=130, grand_total_bdt=1930)
        orders.validate_order(payload)

    def test_unknown_dhaka_locality_requires_clarification(self):
        payload = sample_order()
        payload["customer"].update(thana="Unrecognized", address_line="House 12, Road 4, Unrecognized")
        with self.assertRaisesRegex(orders.OrderValidationError, "unrecognized"):
            orders.validate_order(payload)

    def test_remote_rate_requires_explicit_upstream_flag(self):
        payload = sample_order()
        payload["customer"].update(district="Rajshahi", thana="Bagha", zone="OUTSIDE_DHAKA", address_line="Village Arani, Union Arani, Bagha")
        payload["pricing_summary"].update(delivery_charge_bdt=150, grand_total_bdt=1950)
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(payload)
        payload["customer"]["remote_area"] = True
        orders.validate_order(payload)
        payload["customer"]["remote_area"] = "true"
        with self.assertRaises(orders.OrderValidationError):
            orders.validate_order(payload)

    def test_address_needs_street_or_rural_details(self):
        for address in ("Dhaka", "Dhaka Uttara", "Rajshahi Rajshahi", "House missing", "House missing Uttara", "House 12"):
            payload = sample_order()
            payload["customer"]["address_line"] = address
            with self.subTest(address=address), self.assertRaises(orders.OrderValidationError):
                orders.validate_order(payload)

    def test_rural_components_accept_prefix_and_suffix_names(self):
        for address in (
            "Village Panisara, Union Panisara",
            "Panisara village, Panisara union",
            "Panisara village Panisara union",
            "গ্রাম পানিসারা, ইউনিয়ন পানিসারা",
            "পানিসারা গ্রাম, পানিসারা ইউনিয়ন",
            "পানিসারা গ্রাম পানিসারা ইউনিয়ন",
        ):
            payload = sample_order()
            payload["customer"].update(address_line=address, thana="Jhikargachha", district="Jashore", zone="OUTSIDE_DHAKA")
            payload["pricing_summary"].update(delivery_charge_bdt=130, grand_total_bdt=1930)
            with self.subTest(address=address):
                orders.validate_order(payload)

    def test_rural_marker_only_and_placeholder_values_are_rejected(self):
        for address in (
            "village, union", "Village missing, Union unknown", "missing village, unknown union",
            "missing village, Panisara union", "Panisara village, unknown union",
            "Panisara village union", "গ্রাম, ইউনিয়ন", "অজানা গ্রাম, নেই ইউনিয়ন",
            "অজানা গ্রাম, পানিসারা ইউনিয়ন", "পানিসারা গ্রাম, অজানা ইউনিয়ন",
        ):
            payload = sample_order()
            payload["customer"].update(address_line=address, thana="Jhikargachha", district="Jashore", zone="OUTSIDE_DHAKA")
            payload["pricing_summary"].update(delivery_charge_bdt=130, grand_total_bdt=1930)
            with self.subTest(address=address), self.assertRaises(orders.OrderValidationError):
                orders.validate_order(payload)

    def test_optional_trusted_metadata_and_strict_extra_fields(self):
        payload = sample_order()
        payload.update(courier_metadata={"recipient_city": 1, "recipient_zone": 10, "recipient_area": 100, "item_weight_kg": 0.5}, messenger_psid="123456789", messenger_last_interaction_at="2026-10-13T10:00:00+06:00", confirmation_message="Dhonyobad!\nOrder confirmed.")
        canonical = orders.validate_order(payload)
        self.assertEqual(canonical["courier_metadata"]["item_weight_kg"], 0.5)
        for mutate in (
            lambda p: p.update(arbitrary_url="https://example.com"),
            lambda p: p["courier_metadata"].update(recipient_city=True),
            lambda p: p["courier_metadata"].update(item_weight_kg=float("nan")),
            lambda p: p.update(messenger_psid="not-a-psid"),
            lambda p: p.update(messenger_last_interaction_at="2026-10-13T10:00:00"),
        ):
            invalid = copy.deepcopy(payload)
            mutate(invalid)
            with self.subTest(payload=invalid), self.assertRaises(orders.OrderValidationError):
                orders.validate_order(invalid)

    def test_fingerprint_matches_draft_final_but_changes_with_details_or_id(self):
        original = orders.validate_order(sample_order())
        draft = copy.deepcopy(original)
        draft["order_event"] = "ORDER_DRAFT"
        draft["messenger_psid"] = "1234"
        self.assertEqual(orders.confirmation_fingerprint(original), orders.confirmation_fingerprint(draft))
        draft["order_id"] = "BD-20261013-002"
        self.assertNotEqual(orders.confirmation_fingerprint(original), orders.confirmation_fingerprint(draft))
        draft["order_id"] = original["order_id"]
        draft["customer"]["address_line"] = "House 13, Road 4, Sector 3, Uttara"
        self.assertNotEqual(orders.confirmation_fingerprint(original), orders.confirmation_fingerprint(draft))


class ExtractionTests(unittest.TestCase):
    def test_only_final_fenced_json_order_is_extracted(self):
        payload = sample_order()
        text = "Order confirmed.\n```json\n" + json.dumps(payload) + "\n```\n"
        self.assertEqual(orders.extract_order(text), payload)
        self.assertIsNone(orders.extract_order(text + "More text"))
        self.assertIsNone(orders.extract_order(json.dumps(payload)))
        self.assertIsNone(orders.extract_order("```json\n{\"message\":\"hello\"}\n```"))
        self.assertEqual(orders.extract_order("```json\n{\"x\": 1}\n```\n" + text), payload)

    def test_invalid_duplicate_or_nonfinite_json_is_not_extracted(self):
        for raw in ('{"order_event":"ORDER_CONFIRMED",}', '{"order_event":"ORDER_CONFIRMED","order_event":"ORDER_DRAFT"}', '{"order_event":"ORDER_CONFIRMED","value":NaN}', '{"order_event":{}}', '[]'):
            with self.subTest(raw=raw):
                self.assertIsNone(orders.extract_order("```json\n" + raw + "\n```"))


if __name__ == "__main__":
    unittest.main()
