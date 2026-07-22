def test_credentials_catalog(auth_headers, client):
    response = client.get("/api/v1/credentials/catalog", headers=auth_headers)
    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload, list)
    assert payload[0]["key"]


def test_credentials_ensure_creates_profile(auth_headers, client):
    response = client.post(
        "/api/v1/credentials/ensure",
        headers=auth_headers,
        json={
            "device_type": "router",
            "monitoring_subtype": "mikrotik",
            "protocol": "SNMPv3",
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["catalog_key"] == "router:mikrotik:SNMPv3"
    assert payload["profile"]["name"].startswith("Auto · SNMP ·")

    again = client.post(
        "/api/v1/credentials/ensure",
        headers=auth_headers,
        json={
            "device_type": "router",
            "monitoring_subtype": "mikrotik",
            "protocol": "SNMPv3",
        },
    )
    assert again.status_code == 200
    assert again.json()["profile"]["id"] == payload["profile"]["id"]


def test_credentials_list(auth_headers, client):
    client.post(
        "/api/v1/credentials/ensure",
        headers=auth_headers,
        json={"device_type": "server", "monitoring_subtype": "linux", "protocol": "Zabbix agent2"},
    )
    response = client.get("/api/v1/credentials", headers=auth_headers)
    assert response.status_code == 200
    assert len(response.json()) >= 1


def test_device_create_with_auto_profile(auth_headers, client):
    site = client.post(
        "/api/v1/sites",
        headers=auth_headers,
        json={"name": "Lab", "timezone": "Europe/Moscow", "tags": []},
    ).json()
    response = client.post(
        "/api/v1/devices",
        headers=auth_headers,
        json={
            "site_id": site["id"],
            "name": "Switch-1",
            "address": "10.20.1.50",
            "device_type": "router",
            "monitoring_subtype": "mikrotik",
            "protocol": "SNMPv3",
            "auto_provision": False,
        },
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["credential_profile_id"]
    assert payload["protocol"] == "SNMPv3"
    assert payload["provision"]["zabbix_provisioned"] is False
