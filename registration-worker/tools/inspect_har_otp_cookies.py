"""Inspect OTP request cookie names and response Set-Cookie names in a HAR."""
import json
import sys
from pathlib import Path

har_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("checkout-example.har")
har = json.loads(har_path.read_text(encoding="utf-8"))
entries = har["log"]["entries"]
for i in (527, 530):
    e = entries[i]
    url = e["request"]["url"]
    op = url.split("?")[-1] if "?" in url else url
    print(f"==== entry #{i} ({op}) ====")
    for h in e["request"].get("headers") or []:
        if h.get("name", "").lower() == "cookie":
            cookies = h.get("value", "")
            names = [c.split("=", 1)[0].strip() for c in cookies.split(";")]
            print(f"  REQ cookie names ({len(names)}): {names}")
            break
    set_cookies = []
    for h in e["response"].get("headers") or []:
        if h.get("name", "").lower() == "set-cookie":
            name = h.get("value", "").split("=", 1)[0]
            set_cookies.append(name)
    if set_cookies:
        print(f"  RESP Set-Cookie names ({len(set_cookies)}): {set_cookies}")
    print()
