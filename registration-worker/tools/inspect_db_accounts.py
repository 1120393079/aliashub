"""一次性诊断脚本：看 account_manager.db 里 chatgpt 账号情况，挑一个能用来跑
payment_link 的账号 ID 出来。

读完即用，不写任何字段，不修改任何账号。
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path


def main(db_path: str = "account_manager.db") -> int:
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    # 1) 看每个账号的 plan_state / lifecycle / 凭据可用度
    print("=== chatgpt accounts with plan_state + token availability ===")
    cur.execute(
        """
        SELECT a.id, a.email, ao.plan_state, ao.lifecycle_status, ao.validity_status,
               (SELECT COUNT(*) FROM account_credentials c
                WHERE c.account_id=a.id AND c.key='access_token') AS has_at,
               (SELECT COUNT(*) FROM account_credentials c
                WHERE c.account_id=a.id AND c.key='refresh_token') AS has_rt,
               (SELECT COUNT(*) FROM account_credentials c
                WHERE c.account_id=a.id AND c.key='cookies') AS has_cookies,
               (SELECT COUNT(*) FROM account_credentials c
                WHERE c.account_id=a.id AND c.key='session_token') AS has_st,
               a.created_at
        FROM accounts a
        LEFT JOIN account_overviews ao ON ao.account_id = a.id
        WHERE a.platform='chatgpt'
        ORDER BY a.id DESC
        LIMIT 30
        """
    )
    rows = cur.fetchall()
    print(f"{'id':>4} {'plan_state':<14} {'lifecycle':<14} {'validity':<10} {'AT':>2} {'RT':>2} {'CK':>2} {'ST':>2}  email  created_at")
    for r in rows:
        aid, email, plan, lc, val, hat, hrt, hck, hst, ca = r
        print(f"{aid:>4} {str(plan or ''):<14} {str(lc or ''):<14} {str(val or ''):<10} {hat:>2} {hrt:>2} {hck:>2} {hst:>2}  {email}  {ca}")
    print()

    # 2) 哪些账号有完整凭据（access_token + refresh_token + cookies）—— 可发起 payment_link
    print("=== chatgpt accounts ready to trigger payment_link (has access_token + refresh_token + cookies) ===")
    cur.execute(
        """
        SELECT a.id, a.email, ao.plan_state
        FROM accounts a
        LEFT JOIN account_overviews ao ON ao.account_id = a.id
        WHERE a.platform='chatgpt'
          AND a.id IN (SELECT account_id FROM account_credentials WHERE key='access_token' AND value != '')
          AND a.id IN (SELECT account_id FROM account_credentials WHERE key='refresh_token' AND value != '')
          AND a.id IN (SELECT account_id FROM account_credentials WHERE key='cookies' AND value != '')
        ORDER BY a.id DESC
        LIMIT 10
        """
    )
    for r in cur.fetchall():
        print(r)
    print()

    # 3) provider_settings 里 YesCaptcha 是否配置
    print("=== provider_settings: YesCaptcha config ===")
    cur.execute(
        "SELECT id, provider_type, provider_key, display_name, enabled, "
        "length(config_json) AS cfg_len, length(auth_json) AS auth_len "
        "FROM provider_settings WHERE provider_type='captcha'"
    )
    for r in cur.fetchall():
        print(r)
    print()

    # 4) proxies
    print("=== proxies ===")
    cur.execute("SELECT id, url, region, is_active, success_count, fail_count FROM proxies")
    for r in cur.fetchall():
        print(r)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "account_manager.db"))
