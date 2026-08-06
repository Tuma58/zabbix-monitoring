def test_probe_networks_get_defaults(auth_headers, client):
    response = client.get("/api/v1/settings/probe-networks", headers=auth_headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "10.0.0.0/8" in payload["networks"]
    assert payload["source"] == "env"


def test_probe_networks_update_and_probe(auth_headers, client):
    update = client.put(
        "/api/v1/settings/probe-networks",
        headers=auth_headers,
        json={"networks": ["10.0.0.0/8", "101.102.103.0/24"]},
    )
    assert update.status_code == 200, update.text
    payload = update.json()
    assert payload["networks"] == ["10.0.0.0/8", "101.102.103.0/24"]
    assert payload["source"] == "database"

    site = client.post(
        "/api/v1/sites",
        headers=auth_headers,
        json={"name": "NetLab", "timezone": "Europe/Moscow", "tags": []},
    ).json()

    allowed = client.post(
        "/api/v1/devices/probe",
        headers={**auth_headers, "Idempotency-Key": "net-ok"},
        json={
            "site_id": site["id"],
            "address": "101.102.103.10",
            "device_type": "router",
            "protocol": "SNMPv3",
        },
    )
    assert allowed.status_code == 202, allowed.text

    denied = client.post(
        "/api/v1/devices/probe",
        headers={**auth_headers, "Idempotency-Key": "net-denied"},
        json={
            "site_id": site["id"],
            "address": "8.8.8.8",
            "device_type": "router",
            "protocol": "SNMPv3",
        },
    )
    assert denied.status_code == 400
    assert denied.json()["code"] == "VALIDATION_FAILED"


def test_probe_networks_rejects_invalid_cidr(auth_headers, client):
    response = client.put(
        "/api/v1/settings/probe-networks",
        headers=auth_headers,
        json={"networks": ["not-a-network"]},
    )
    assert response.status_code == 400
