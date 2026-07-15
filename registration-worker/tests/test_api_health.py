"""Health / readiness endpoint tests."""
from __future__ import annotations


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("ok") is True


def test_ready(client):
    resp = client.get("/api/ready")
    assert resp.status_code == 200
