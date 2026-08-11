import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app import BEIJING_TIMEZONE, Config, PickupStore, api_beijing_times, parse_query_timestamp


class PickupDeliveryFormatTests(unittest.TestCase):
    def test_unbound_external_mailbox_can_receive_an_empty_pickup_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = PickupStore(Config(
                host="127.0.0.1",
                port=4190,
                database_path=str(root / "pickup.db"),
                domain="pickup.test",
                public_base_url="https://pickup.example",
                inbound_token="inbound-token-for-test-only",
                token_secret="token-secret-long-enough-for-test",
                admin_username="admin",
                admin_password="secret",
                alias_hub_database_path=str(root / "missing-alias.db"),
            ))

            created = store.create_mailboxes(
                items=[{"email": "external@example.com"}],
                allow_unbound=True,
            )[0]
            token = parse_qs(urlparse(created["pickup_url"]).query)["token"][0]

            self.assertEqual(created["source_provider"], "unbound")
            self.assertIsNone(created["source_account_id"])
            self.assertEqual(store.public_messages(token), {
                "email": "external@example.com",
                "expires_at": None,
                "messages": [],
            })

            repeated = store.create_mailboxes(
                items=[{"email": "external@example.com"}],
                upsert=True,
                allow_unbound=True,
            )[0]
            self.assertEqual(repeated["pickup_url"], created["pickup_url"])

    def test_delivery_includes_available_password_but_not_access_token(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = PickupStore(Config(
                host="127.0.0.1",
                port=4190,
                database_path=str(root / "pickup.db"),
                domain="example.com",
                public_base_url="https://pickup.example",
                inbound_token="inbound-token-for-test-only",
                token_secret="token-secret-long-enough-for-test",
                admin_username="admin",
                admin_password="secret",
                alias_hub_database_path=str(root / "alias.db"),
            ))
            created = store.create_mailboxes(items=[{
                "email": "buyer@example.com",
                "password": "must-be-cleared",
                "access_token": "at-must-be-cleared",
            }])
            self.assertEqual(
                created[0]["delivery_line"],
                f"账号：buyer@example.com----密码：must-be-cleared----取件链接：{created[0]['pickup_url']}",
            )
            self.assertIn("密码：must-be-cleared", created[0]["delivery_line"])
            self.assertNotIn("AT：", created[0]["delivery_line"])

            updated = store.create_mailboxes(
                items=[{"email": "buyer@example.com"}],
                upsert=True,
                clear_credentials=True,
            )
            self.assertEqual(updated[0]["account_password"], "")
            self.assertEqual(updated[0]["access_token"], "")
            self.assertEqual(
                updated[0]["delivery_line"],
                f"buyer@example.com {updated[0]['pickup_url']}",
            )

    def test_latest_message_api_returns_the_newest_complete_message(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = PickupStore(Config(
                host="127.0.0.1",
                port=4190,
                database_path=str(root / "pickup.db"),
                domain="example.com",
                public_base_url="https://pickup.example",
                inbound_token="inbound-token-for-test-only",
                token_secret="token-secret-long-enough-for-test",
                admin_username="admin",
                admin_password="secret",
                alias_hub_database_path=str(root / "alias.db"),
            ))
            created = store.create_mailboxes(items=[{"email": "buyer@example.com"}])[0]
            token = parse_qs(urlparse(created["pickup_url"]).query)["token"][0]
            mailbox_id = created["id"]
            with store.connect() as db:
                db.execute(
                    """
                    INSERT INTO pickup_messages
                        (mailbox_id, fingerprint, sender_name, sender_address, subject,
                         text_body, received_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (mailbox_id, "older", "Old", "old@example.com", "Older", "old body",
                     "2026-08-04T08:00:00Z", "2026-08-04T08:00:00Z"),
                )
                db.execute(
                    """
                    INSERT INTO pickup_messages
                        (mailbox_id, fingerprint, sender_name, sender_address, subject,
                         text_body, received_at, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (mailbox_id, "newer", "OpenAI", "noreply@openai.com", "Newest",
                     "line one\n\n\nline two", "2026-08-04T09:00:00Z", "2026-08-04T09:00:00Z"),
                )

            result = store.public_latest_message(token)

            self.assertTrue(result["ok"])
            self.assertTrue(result["has_message"])
            self.assertEqual(result["email"], "buyer@example.com")
            self.assertEqual(result["message"]["subject"], "Newest")
            self.assertEqual(result["message"]["text_body"], "line one\n\nline two")
            self.assertEqual(result["message"]["recipient"], "buyer@example.com")
            self.assertEqual(
                created["pickup_api_url"],
                f"https://pickup.example/api/query.php?mail=buyer%40example.com&pwd={token}&limit=1",
            )
            compatible = store.public_query("buyer@example.com", token, 1)
            self.assertEqual(compatible["status"], "success")
            self.assertEqual(len(compatible["data"]), 1)
            self.assertEqual(compatible["data"][0], {
                "body": "line one\n\nline two",
                "from": "OpenAI <noreply@openai.com>",
                "saved_at": "2026-08-04 17:00:00",
                "subject": "Newest",
                "to": "buyer@example.com",
            })
            after_timestamp = store.public_query(
                "buyer@example.com",
                token,
                10,
                "1785828600",
            )
            self.assertEqual(
                [item["subject"] for item in after_timestamp["data"]],
                ["Older", "Newest"],
            )
            first_after_timestamp = store.public_query(
                "buyer@example.com",
                token,
                1,
                "1785828600",
            )
            self.assertEqual(first_after_timestamp["data"][0]["subject"], "Older")
            after_milliseconds = store.public_query(
                "buyer@example.com",
                token,
                10,
                "1785832200000",
            )
            self.assertEqual([item["subject"] for item in after_milliseconds["data"]], ["Newest"])
            after_iso = store.public_query(
                "buyer@example.com",
                token,
                10,
                "2026-08-04T09:00:00Z",
            )
            self.assertEqual(after_iso["data"], [])
            after_beijing = store.public_query(
                "buyer@example.com",
                token,
                10,
                "2026-08-04 16:30:00",
            )
            self.assertEqual([item["subject"] for item in after_beijing["data"]], ["Newest"])

    def test_api_time_parameters_and_responses_use_beijing_time(self):
        parsed = parse_query_timestamp("2026-08-04 16:30:00")
        self.assertEqual(parsed.isoformat(), "2026-08-04T08:30:00+00:00")
        self.assertEqual(parsed.astimezone(BEIJING_TIMEZONE).hour, 16)
        self.assertEqual(
            api_beijing_times({
                "created_at": "2026-08-04T09:00:00Z",
                "nested": [{"soldAt": "2026-08-04 17:30:00"}],
                "saved_at": "2026-08-04 09:00:00",
                "label": "2026-08-04T09:00:00Z",
            }),
            {
                "created_at": "2026-08-04T17:00:00+08:00",
                "nested": [{"soldAt": "2026-08-04T17:30:00+08:00"}],
                "saved_at": "2026-08-04 09:00:00",
                "label": "2026-08-04T09:00:00Z",
            },
        )

    def test_latest_message_api_returns_an_empty_polling_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = PickupStore(Config(
                host="127.0.0.1",
                port=4190,
                database_path=str(root / "pickup.db"),
                domain="example.com",
                public_base_url="https://pickup.example",
                inbound_token="inbound-token-for-test-only",
                token_secret="token-secret-long-enough-for-test",
                admin_username="admin",
                admin_password="secret",
                alias_hub_database_path=str(root / "alias.db"),
            ))
            created = store.create_mailboxes(items=[{"email": "empty@example.com"}])[0]
            token = parse_qs(urlparse(created["pickup_url"]).query)["token"][0]

            result = store.public_latest_message(token)

            self.assertEqual(result, {
                "ok": True,
                "email": "empty@example.com",
                "has_message": False,
                "message": None,
            })

    def test_bulk_status_update_changes_selected_mailboxes_and_resets_sale_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = PickupStore(Config(
                host="127.0.0.1",
                port=4190,
                database_path=str(root / "pickup.db"),
                domain="example.com",
                public_base_url="https://pickup.example",
                inbound_token="inbound-token-for-test-only",
                token_secret="token-secret-long-enough-for-test",
                admin_username="admin",
                admin_password="secret",
                alias_hub_database_path=str(root / "alias.db"),
            ))
            rows = store.create_mailboxes(items=[
                {"email": "first@example.com"},
                {"email": "second@example.com"},
                {"email": "unchanged@example.com"},
            ])
            with store.connect() as db:
                db.execute(
                    "UPDATE pickup_mailboxes SET status = 'sold', sold_at = ?, "
                    "ldxp_trade_no = ?, ldxp_card_digest = ? WHERE id IN (?, ?)",
                    ("2026-08-05T01:00:00Z", "trade-1", "digest-1", rows[0]["id"], rows[1]["id"]),
                )
                db.execute(
                    "UPDATE pickup_mailboxes SET status = 'disabled' WHERE id = ?",
                    (rows[2]["id"],),
                )

            result = store.update_mailbox_statuses([rows[0]["id"], str(rows[1]["id"])], "ready")

            self.assertEqual(result["updated"], 2)
            self.assertEqual(result["skipped"], 0)
            first = store.get_admin_mailbox(rows[0]["id"])
            second = store.get_admin_mailbox(rows[1]["id"])
            unchanged = store.get_admin_mailbox(rows[2]["id"])
            for mailbox in (first, second):
                self.assertEqual(mailbox["status"], "ready")
                self.assertIsNone(mailbox["sold_at"])
                self.assertEqual(mailbox["ldxp_trade_no"], "")
                self.assertEqual(mailbox["ldxp_card_digest"], "")
            self.assertEqual(unchanged["status"], "disabled")

            with self.assertRaisesRegex(ValueError, "状态无效"):
                store.update_mailbox_statuses([rows[0]["id"]], "unknown")


if __name__ == "__main__":
    unittest.main()
