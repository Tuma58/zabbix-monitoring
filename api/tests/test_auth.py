def test_login_and_me(client, auth_headers):
    me = client.get("/api/v1/me", headers=auth_headers)
    assert me.status_code == 200
    body = me.json()
    assert body["email"] == "admin@example.com"
    assert "admin" in body["roles"]


def test_login_rejects_bad_password(client):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": "wrong-password"},
    )
    assert response.status_code == 401
    assert response.json()["code"] == "AUTH_REQUIRED"


def test_refresh_rotates_token(client):
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@example.com", "password": "TestPass123!"},
    ).json()
    refresh = client.post("/api/v1/auth/refresh", json={"refresh_token": login["refresh_token"]})
    assert refresh.status_code == 200
    body = refresh.json()
    assert body["access_token"]
    assert body["refresh_token"] != login["refresh_token"]
