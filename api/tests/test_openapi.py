def test_openapi_contains_stage1_paths(client):
    response = client.get("/api/v1/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    expected = [
        "/api/v1/health/live",
        "/api/v1/health/ready",
        "/api/v1/auth/login",
        "/api/v1/auth/refresh",
        "/api/v1/me",
        "/api/v1/sites",
        "/api/v1/devices",
        "/api/v1/devices/probe",
        "/api/v1/dashboard/summary",
        "/api/v1/problems",
        "/api/v1/audit-events",
    ]
    for path in expected:
        assert path in paths, path


def test_dashboard_summary_requires_auth(client, auth_headers):
    denied = client.get("/api/v1/dashboard/summary")
    assert denied.status_code == 401
    ok = client.get("/api/v1/dashboard/summary", headers=auth_headers)
    assert ok.status_code == 200
    body = ok.json()
    assert "availability" in body
    assert "problems" in body


def test_probe_idempotency(client, auth_headers):
    created = client.post(
        "/api/v1/sites",
        headers=auth_headers,
        json={"name": "Lab", "timezone": "UTC", "tags": ["lab"]},
    )
    assert created.status_code == 201
    site_id = created.json()["id"]
    payload = {
        "site_id": site_id,
        "address": "10.1.1.5",
        "device_type": "ups",
        "protocol": "snmpv3",
    }
    headers = {**auth_headers, "Idempotency-Key": "probe-lab-1"}
    first = client.post("/api/v1/devices/probe", headers=headers, json=payload)
    second = client.post("/api/v1/devices/probe", headers=headers, json=payload)
    assert first.status_code == 202
    assert second.status_code == 202
    assert first.json()["id"] == second.json()["id"]
    assert "password" not in str(first.json()).lower()
