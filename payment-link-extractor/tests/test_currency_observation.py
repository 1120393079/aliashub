from __future__ import annotations

import unittest
from unittest.mock import patch

from payment_link_extractor.checkout import require_country_currency
from payment_link_extractor.errors import ProtocolError
from payment_link_extractor.flows.cs_live import extract_cs_live_provider
from payment_link_extractor.models import ExtractionConfig


class StripeCurrencyObservationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config = ExtractionConfig(
            access_token="fixture-token",
            checkout_proxy="http://proxy.example:8080",
            update_proxy="http://proxy.example:8080",
            country="BR",
        )

    def run_provider(self, currency: str) -> dict[str, object]:
        checkout: dict[str, object] = {
            "cs_id": "cs_live_fixture",
            "currency": "BRL",
            "billing_country": "BR",
        }
        init_payload = {
            "currency": currency,
            "total_summary": {"due": 999, "total": 999},
            "payment_method_types": ["paypal"],
            "stripe_hosted_url": "https://checkout.stripe.test/c/pay/fixture",
        }
        paypal_url = "https://www.paypal.com/agreements/approve?ba_token=BA-FIXTURE"

        with (
            patch(
                "payment_link_extractor.flows.cs_live.stripe_init",
                return_value=(init_payload, "stripe-js-fixture"),
            ),
            patch(
                "payment_link_extractor.flows.cs_live.stripe_context",
                return_value={"checkout_amount": "999", "currency": currency.lower()},
            ),
            patch("payment_link_extractor.flows.cs_live.ensure_payment_method_offered"),
            patch("payment_link_extractor.flows.cs_live.cs_elements_session", return_value={}),
            patch("payment_link_extractor.flows.cs_live.cs_update_tax_region"),
            patch("payment_link_extractor.flows.cs_live.cs_checkout_taxes"),
            patch("payment_link_extractor.flows.cs_live.cs_snapshot_billing"),
            patch(
                "payment_link_extractor.flows.cs_live.stripe_create_payment_method",
                return_value="pm_fixture",
            ),
            patch("payment_link_extractor.flows.cs_live.stripe_confirm_cs_live", return_value={}),
            patch(
                "payment_link_extractor.flows.cs_live.provider_redirect_after_confirm",
                return_value=paypal_url,
            ),
            patch(
                "payment_link_extractor.flows.cs_live.resolve_external_redirect",
                return_value=paypal_url,
            ),
        ):
            extract_cs_live_provider(
                self.config,
                object(),
                object(),
                checkout,
                {
                    "name": "Fixture",
                    "email": "fixture@example.test",
                    "line1": "Fixture street",
                    "city": "Sao Paulo",
                    "postal_code": "01000-000",
                    "country": "BR",
                    "state": "SP",
                },
                None,
            )
        return checkout

    def test_stripe_currency_is_marked_as_observed(self) -> None:
        checkout = self.run_provider("brl")

        self.assertEqual(checkout["currency"], "BRL")
        self.assertIs(checkout["currency_observed"], True)
        require_country_currency(
            checkout,
            self.config,
            require_observed_currency=True,
        )

    def test_observed_wrong_currency_is_rejected(self) -> None:
        checkout = self.run_provider("usd")

        with self.assertRaises(ProtocolError):
            require_country_currency(
                checkout,
                self.config,
                require_observed_currency=True,
            )

    def test_config_fallback_is_not_treated_as_observed(self) -> None:
        checkout = self.run_provider("")

        self.assertEqual(checkout["currency"], "BRL")
        self.assertNotIn("currency_observed", checkout)
        with self.assertRaises(ProtocolError):
            require_country_currency(
                checkout,
                self.config,
                require_observed_currency=True,
            )


if __name__ == "__main__":
    unittest.main()
