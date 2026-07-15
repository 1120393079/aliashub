"""Lifecycle management API tests."""
from __future__ import annotations


def test_lifecycle_status(client):
    resp = client.get("/api/lifecycle/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "running" in data
    assert "check_interval_hours" in data
    assert "refresh_interval_hours" in data
    assert "warning_hours" in data


def test_trigger_validity_check_empty(client):
    resp = client.post("/api/lifecycle/check", json={"platform": "", "limit": 10})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["data"]["valid"] == 0
    assert data["data"]["invalid"] == 0


def test_trigger_token_refresh_empty(client):
    resp = client.post("/api/lifecycle/refresh", json={"platform": "", "limit": 10})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["data"]["refreshed"] == 0


def test_trigger_expiry_warning_empty(client):
    resp = client.post("/api/lifecycle/warn", json={"hours": 48})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True


def test_trigger_check_with_platform_filter(client):
    resp = client.post("/api/lifecycle/check", json={"platform": "chatgpt", "limit": 5})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
