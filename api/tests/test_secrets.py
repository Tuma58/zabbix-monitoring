from app.config import Settings
from app.services.audit import sanitize_payload
from app.services.secrets import SecretBox


def test_secret_box_roundtrip_and_public_view():
    box = SecretBox(Settings(secrets_master_key="unit-test-master-key-32bytes!!"))
    payload = {
        "username": "monitor",
        "auth_passphrase": "super-secret",
        "priv_passphrase": "another-secret",
        "security_level": "authPriv",
    }
    encrypted = box.encrypt(payload)
    decrypted = box.decrypt(encrypted)
    assert decrypted["auth_passphrase"] == "super-secret"
    public = box.public_view("snmpv3", decrypted)
    assert public["username"] == "monitor"
    assert "auth_passphrase" not in public
    assert public["has_secrets"] is True


def test_audit_sanitize_redacts_secrets():
    cleaned = sanitize_payload(
        {
            "password": "x",
            "nested": {"community": "public", "ok": True},
            "authorization": "Bearer abc",
        }
    )
    assert cleaned["password"] == "***"
    assert cleaned["nested"]["community"] == "***"
    assert cleaned["authorization"] == "***"
    assert cleaned["nested"]["ok"] is True
