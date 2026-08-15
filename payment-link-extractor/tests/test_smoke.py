import os
import unittest
from unittest.mock import patch

from payment_link_extractor.checkout import merge_checkout_payload, require_country_currency
from payment_link_extractor.config import country_config
from payment_link_extractor.errors import ProtocolError
from payment_link_extractor.models import ExtractionConfig
from payment_link_extractor.transport import normalize_proxy_url
from payment_link_extractor.web.app import create_app
from payment_link_extractor.web.tasks import TaskManager


class PaymentLinkExtractorSmokeTest(unittest.TestCase):
    def setUp(self):
        self.manager = TaskManager(max_workers=1)
        self.app = create_app(
            {"TESTING": True, "WEB_PASSWORD": "test-password"},
            task_manager=self.manager,
        )
        self.client = self.app.test_client()

    def tearDown(self):
        self.manager.close()

    def test_health_requires_the_configured_password(self):
        self.assertEqual(self.client.get("/api/health").status_code, 401)
        response = self.client.get(
            "/api/health",
            headers={"X-Workbench-Password": "test-password"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"ok": True, "service": "payment-link-extractor"})

    def test_alias_hub_billing_profiles_keep_requested_currencies(self):
        self.assertEqual(country_config("DE")[1], "EUR")
        self.assertEqual(country_config("TR")[1], "USD")
        self.assertEqual(country_config("GB")[1], "EUR")

    def test_upstream_currency_overrides_requested_placeholder_and_is_rejected(self):
        checkout = {"billing_country": "GB", "currency": "EUR"}
        merge_checkout_payload(checkout, {"checkout_state": {"currency": "GBP"}})
        config = ExtractionConfig(
            access_token="fixture-token",
            checkout_proxy="http://proxy.example:8080",
            update_proxy="http://proxy.example:8080",
            country="GB",
        )
        with self.assertRaises(ProtocolError):
            require_country_currency(checkout, config, require_observed_currency=True)

    def test_iprocket_proxy_uses_the_local_chain_bridge(self):
        with patch.dict(os.environ, {"IPROCKET_CHAIN_PROXY": "http://127.0.0.1:18796"}, clear=False):
            normalized = normalize_proxy_url("gate.iprocket.io:5959:fixture-user:fixture-password")
        self.assertTrue(normalized.startswith("http://iprb_"))
        self.assertTrue(normalized.endswith("@127.0.0.1:18796"))

    def test_defaults_allow_per_task_country_selection(self):
        with patch.dict(os.environ, {"OPLL_COUNTRY": "GB", "OPLL_FORCE_COUNTRY": ""}, clear=False):
            response = self.client.get(
                "/api/defaults",
                headers={"X-Workbench-Password": "test-password"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["country"], "GB")
        self.assertEqual(response.get_json()["force_country"], "")


if __name__ == "__main__":
    unittest.main()
