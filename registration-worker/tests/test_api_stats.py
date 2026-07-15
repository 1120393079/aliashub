"""Registration stats dashboard API tests."""
from __future__ import annotations


def test_stats_overview_empty(client):
    resp = client.get("/api/stats/overview")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_registrations"] == 0
    assert data["success"] == 0
    assert data["failed"] == 0
    assert data["success_rate"] == 0
    assert data["total_accounts"] == 0


def test_stats_by_platform_empty(client):
    resp = client.get("/api/stats/by-platform")
    assert resp.status_code == 200
    assert resp.json() == []


def test_stats_by_day_empty(client):
    resp = client.get("/api/stats/by-day")
    assert resp.status_code == 200
    assert resp.json() == []


def test_stats_by_day_with_platform_filter(client):
    resp = client.get("/api/stats/by-day", params={"days": 7, "platform": "chatgpt"})
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_stats_by_proxy_empty(client):
    resp = client.get("/api/stats/by-proxy")
    assert resp.status_code == 200
    assert resp.json() == []


def test_stats_by_proxy_with_data(client):
    # Add a proxy first
    client.post("/api/proxies", json={"url": "http://1.2.3.4:8080", "region": "US"})
    resp = client.get("/api/stats/by-proxy")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["url"] == "http://1.2.3.4:8080"
    assert data[0]["success_rate"] == 0


def test_stats_errors_empty(client):
    resp = client.get("/api/stats/errors")
    assert resp.status_code == 200
    assert resp.json() == []


def test_stats_errors_with_platform_filter(client):
    resp = client.get("/api/stats/errors", params={"days": 7, "platform": "cursor"})
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
