"""Proxy management endpoint tests."""
from __future__ import annotations

import time

import pytest

from application.proxies import PROXY_INSPECTION_DEADLINE_SECONDS


def _profile(ip: str) -> dict:
    suffix = int(ip.rsplit(".", 1)[-1])
    return {
        "ip": ip,
        "country_code": "JP",
        "country_name": "Japan",
        "locale": "ja-JP",
        "language": "ja",
        "timezone": "Asia/Tokyo",
        "latitude": 35.68 + suffix / 1000,
        "longitude": 139.76 + suffix / 1000,
    }


def test_list_proxies_empty(client):
    resp = client.get("/api/proxies")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 0


def test_add_proxy(client):
    resp = client.post("/api/proxies", json={"url": "http://127.0.0.1:7890", "region": "US"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["url"] == "http://127.0.0.1:7890"
    assert data["region"] == "US"


def test_add_and_list_proxy(client):
    client.post("/api/proxies", json={"url": "http://127.0.0.1:7890"})
    resp = client.get("/api/proxies")
    data = resp.json()
    assert len(data) == 1


def test_delete_proxy(client):
    create_resp = client.post("/api/proxies", json={"url": "http://127.0.0.1:7890"})
    proxy_id = create_resp.json()["id"]
    del_resp = client.delete(f"/api/proxies/{proxy_id}")
    assert del_resp.status_code == 200
    # Verify deleted
    list_resp = client.get("/api/proxies")
    assert len(list_resp.json()) == 0


def test_bulk_add_proxies(client):
    resp = client.post("/api/proxies/bulk", json={
        "proxies": ["http://1.1.1.1:8080", "http://2.2.2.2:8080"],
        "region": "SG",
    })
    assert resp.status_code == 200
    list_resp = client.get("/api/proxies")
    assert len(list_resp.json()) == 2


def test_inspect_proxy_detects_rotating_exit_without_leaking_credentials(client, monkeypatch):
    detected = iter(["203.0.113.10", "203.0.113.11", "203.0.113.10"])
    calls = []

    def detect(proxy, *, deadline):
        calls.append(proxy)
        assert deadline > time.monotonic()
        return next(detected)

    monkeypatch.setattr("application.proxies._detect_public_ip", detect)
    monkeypatch.setattr("application.proxies._region_profile_for_ip", _profile)

    resp = client.post("/api/proxies/inspect", json={
        "url": "http://proxy-user:super-secret@proxy.example:8080",
        "samples": 3,
        "delay_ms": 0,
    })

    assert resp.status_code == 200
    data = resp.json()
    assert data["dynamic"] is True
    assert data["distinct_ips"] == ["203.0.113.10", "203.0.113.11"]
    assert [item["ip"] for item in data["samples"]] == [
        "203.0.113.10",
        "203.0.113.11",
        "203.0.113.10",
    ]
    assert len(calls) == 3
    assert all(item["country_code"] == "JP" for item in data["samples"])
    assert "proxy-user" not in resp.text
    assert "super-secret" not in resp.text
    assert "proxy.example" not in resp.text


def test_inspect_proxy_reports_static_exit(client, monkeypatch):
    calls = []

    def detect(proxy, *, deadline):
        calls.append(proxy)
        assert deadline > time.monotonic()
        return "198.51.100.7"

    monkeypatch.setattr("application.proxies._detect_public_ip", detect)
    monkeypatch.setattr("application.proxies._region_profile_for_ip", _profile)

    resp = client.post("/api/proxies/inspect", json={
        "url": "socks5://proxy.example:1080",
        "samples": 2,
    })

    assert resp.status_code == 200
    data = resp.json()
    assert data["dynamic"] is False
    assert data["distinct_ips"] == ["198.51.100.7"]
    assert len(data["samples"]) == 2
    assert len(calls) == 2


def test_inspect_proxy_failure_is_credential_safe(client, monkeypatch):
    def fail(proxy, *, deadline):
        raise RuntimeError("cannot connect through http://proxy-user:super-secret@proxy.example:8080")

    monkeypatch.setattr("application.proxies._detect_public_ip", fail)

    resp = client.post("/api/proxies/inspect", json={
        "url": "http://proxy-user:super-secret@proxy.example:8080",
        "samples": 1,
    })

    assert resp.status_code == 502
    assert resp.json() == {"detail": "代理出口检测失败"}
    assert "proxy-user" not in resp.text
    assert "super-secret" not in resp.text
    assert "proxy.example" not in resp.text


@pytest.mark.parametrize(
    "url",
    [
        "ftp://proxy-user:secret@proxy.example:21",
        "file:///tmp/proxy.sock",
        "not-a-proxy-url",
        "socks5h://proxy.example:1080",
        "socks5://proxy-user:secret@proxy.example:1080",
        "http://proxy.example",
        "http://proxy.example:8080/path",
        "http://proxy.example:8080?session=secret",
        "http://proxy.example:8080#secret",
        "http://proxy.exa\nmple:8080",
        "http://proxy.example:8080\n",
        "\thttp://proxy.example:8080",
        "http://proxy-user:super-secret@proxy／example:8080",
        "http://proxy-user@proxy.example:8080",
        "http://:super-secret@proxy.example:8080",
        "http://proxy-user:@proxy.example:8080",
    ],
)
def test_inspect_proxy_rejects_unsupported_or_incomplete_urls(client, url):
    resp = client.post("/api/proxies/inspect", json={"url": url, "samples": 1})

    assert resp.status_code == 400
    assert resp.json() == {"detail": "代理地址无效"}
    assert "proxy-user" not in resp.text
    assert "secret" not in resp.text
    assert "proxy.example" not in resp.text


def test_inspect_proxy_preserves_ipv6_brackets(client, monkeypatch):
    captured = []

    def detect(proxy, *, deadline):
        captured.append(proxy)
        return "198.51.100.7"

    monkeypatch.setattr("application.proxies._detect_public_ip", detect)
    monkeypatch.setattr("application.proxies._region_profile_for_ip", _profile)

    resp = client.post("/api/proxies/inspect", json={
        "url": "http://user:secret@[2001:db8::1]:8080",
        "samples": 1,
    })

    assert resp.status_code == 200
    assert captured[0]["server"] == "http://[2001:db8::1]:8080"
    assert captured[0]["username"] == "user"
    assert captured[0]["password"] == "secret"


def test_inspect_proxy_decodes_paired_http_userinfo(client, monkeypatch):
    captured = []

    def detect(proxy, *, deadline):
        captured.append(proxy)
        return "198.51.100.7"

    monkeypatch.setattr("application.proxies._detect_public_ip", detect)
    monkeypatch.setattr("application.proxies._region_profile_for_ip", _profile)

    resp = client.post("/api/proxies/inspect", json={
        "url": "https://user%40corp:p%3Ass%2Fword@proxy.example:8443",
        "samples": 1,
    })

    assert resp.status_code == 200
    assert captured == [{
        "server": "https://proxy.example:8443",
        "username": "user@corp",
        "password": "p:ss/word",
    }]


def test_inspect_proxy_canonicalizes_ipv6_exits_before_deduplication(client, monkeypatch):
    detected = iter([
        "2001:0DB8:0000:0000:0000:0000:0000:0001",
        "2001:db8::1",
    ])

    def detect(proxy, *, deadline):
        return next(detected)

    def profile(ip):
        return {
            "ip": ip,
            "country_code": "US",
            "country_name": "United States",
            "locale": "en-US",
            "language": "en",
            "timezone": "America/New_York",
            "latitude": 40.71,
            "longitude": -74.0,
        }

    monkeypatch.setattr("application.proxies._detect_public_ip", detect)
    monkeypatch.setattr("application.proxies._region_profile_for_ip", profile)

    resp = client.post("/api/proxies/inspect", json={
        "url": "http://proxy.example:8080",
        "samples": 2,
    })

    assert resp.status_code == 200
    assert resp.json()["dynamic"] is False
    assert resp.json()["distinct_ips"] == ["2001:db8::1"]
    assert [item["ip"] for item in resp.json()["samples"]] == [
        "2001:db8::1",
        "2001:db8::1",
    ]


def test_inspect_proxy_uses_one_bounded_absolute_deadline(client, monkeypatch):
    deadlines = []
    remaining_values = []

    def detect(proxy, *, deadline):
        deadlines.append(deadline)
        remaining_values.append(deadline - time.monotonic())
        return "198.51.100.7"

    monkeypatch.setattr("application.proxies._detect_public_ip", detect)
    monkeypatch.setattr("application.proxies._region_profile_for_ip", _profile)
    resp = client.post("/api/proxies/inspect", json={
        "url": "http://proxy.example:8080",
        "samples": 5,
    })

    assert resp.status_code == 200
    assert 0 < PROXY_INSPECTION_DEADLINE_SECONDS <= 100
    assert len(deadlines) == 5
    assert len(set(deadlines)) == 1
    assert all(0 < value <= PROXY_INSPECTION_DEADLINE_SECONDS for value in remaining_values)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("samples", 0),
        ("samples", 6),
        ("delay_ms", -1),
        ("delay_ms", 2001),
    ],
)
def test_inspect_proxy_rejects_out_of_range_values(client, field, value):
    payload = {
        "url": "http://proxy.example:8080",
        "samples": 1,
        "delay_ms": 0,
    }
    payload[field] = value

    resp = client.post("/api/proxies/inspect", json=payload)

    assert resp.status_code == 422
