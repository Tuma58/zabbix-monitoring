"""Update bootstrap to prefer Alembic migrations when available."""

from __future__ import annotations

import json
import sys

from alembic import command
from alembic.config import Config
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import Device, DeviceStatus, Site
from app.services.auth import ensure_admin_user


def run_migrations() -> None:
    config = Config("alembic.ini")
    command.upgrade(config, "head")


def seed_demo_inventory(db) -> None:
    if db.scalar(select(Site).limit(1)) is not None:
        return

    moscow = Site(name="Москва", timezone="Europe/Moscow", proxy_id="proxy-msk", tags_json='["dc","core"]')
    spb = Site(name="Санкт-Петербург", timezone="Europe/Moscow", proxy_id="proxy-spb", tags_json='["edge"]')
    db.add_all([moscow, spb])
    db.flush()
    db.add_all(
        [
            Device(
                site_id=moscow.id,
                name="core-sw-01",
                address="10.10.1.10",
                device_type="router",
                vendor="Cisco",
                model="C9300",
                status=DeviceStatus.ACTIVE.value,
            ),
            Device(
                site_id=moscow.id,
                name="ups-srv-01",
                address="10.10.2.10",
                device_type="ups",
                vendor="APC",
                model="Smart-UPS",
                status=DeviceStatus.DEGRADED.value,
            ),
            Device(
                site_id=spb.id,
                name="app-srv-02",
                address="10.20.1.20",
                device_type="server",
                vendor="Dell",
                model="R740",
                status=DeviceStatus.ACTIVE.value,
            ),
        ]
    )


def main() -> int:
    settings = get_settings()
    run_migrations()
    with SessionLocal() as db:
        ensure_admin_user(db, settings)
        seed_demo_inventory(db)
        db.commit()
    print(json.dumps({"bootstrap": "ok", "database": settings.database_url.split("@")[-1]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
