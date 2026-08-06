def test_site_update_and_delete(auth_headers, client):
    created = client.post(
        "/api/v1/sites",
        headers=auth_headers,
        json={"name": "Office-A", "timezone": "Europe/Moscow", "tags": []},
    )
    assert created.status_code == 201, created.text
    site_id = created.json()["id"]

    updated = client.patch(
        f"/api/v1/sites/{site_id}",
        headers=auth_headers,
        json={"name": "Office-B", "timezone": "Europe/Samara", "proxy_id": "proxy-1"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Office-B"
    assert updated.json()["proxy_id"] == "proxy-1"

    deleted = client.delete(f"/api/v1/sites/{site_id}", headers=auth_headers)
    assert deleted.status_code == 204


def test_site_delete_blocked_when_devices_exist(auth_headers, client):
    site = client.post(
        "/api/v1/sites",
        headers=auth_headers,
        json={"name": "Busy", "timezone": "Europe/Moscow", "tags": []},
    ).json()
    device = client.post(
        "/api/v1/devices",
        headers=auth_headers,
        json={
            "site_id": site["id"],
            "name": "sw-1",
            "address": "10.1.1.1",
            "device_type": "router",
            "auto_provision": False,
        },
    )
    assert device.status_code == 201, device.text
    blocked = client.delete(f"/api/v1/sites/{site['id']}", headers=auth_headers)
    assert blocked.status_code == 409
    assert blocked.json()["code"] == "SITE_HAS_DEVICES"


def test_device_update_and_delete(auth_headers, client):
    site = client.post(
        "/api/v1/sites",
        headers=auth_headers,
        json={"name": "Lab-X", "timezone": "Europe/Moscow", "tags": []},
    ).json()
    created = client.post(
        "/api/v1/devices",
        headers=auth_headers,
        json={
            "site_id": site["id"],
            "name": "pc-1",
            "address": "10.2.2.2",
            "device_type": "computer",
            "protocol": "ICMP",
            "auto_provision": False,
        },
    )
    assert created.status_code == 201, created.text
    device_id = created.json()["id"]

    updated = client.patch(
        f"/api/v1/devices/{device_id}",
        headers=auth_headers,
        json={"name": "pc-1-renamed", "status": "active"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "pc-1-renamed"
    assert updated.json()["status"] == "active"
    assert updated.json()["version"] == 2

    deleted = client.delete(f"/api/v1/devices/{device_id}", headers=auth_headers)
    assert deleted.status_code == 204
