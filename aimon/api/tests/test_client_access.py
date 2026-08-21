from app.access import client_ip_allowed, normalize_client_cidrs


def test_empty_allowlist_allows_all():
    assert client_ip_allowed("8.8.8.8", [])
    assert client_ip_allowed("10.1.2.3", [])


def test_cidr_and_host():
    nets = normalize_client_cidrs(["10.0.0.0/8", "94.181.191.114"])
    assert "10.0.0.0/8" in nets
    assert "94.181.191.114/32" in nets
    assert client_ip_allowed("10.5.5.5", nets)
    assert client_ip_allowed("94.181.191.114", nets)
    assert not client_ip_allowed("8.8.8.8", nets)


def test_normalize_rejects_junk():
    try:
        normalize_client_cidrs(["not-an-ip"])
        assert False, "expected ValueError"
    except ValueError:
        pass
