"""Update bootstrap to prefer Alembic migrations when available."""

from __future__ import annotations

import json
import sys

from alembic import command
from alembic.config import Config

from app.config import get_settings
from app.db import SessionLocal
from app.services.auth import ensure_admin_user


def run_migrations() -> None:
    config = Config("alembic.ini")
    command.upgrade(config, "head")


def main() -> int:
    settings = get_settings()
    run_migrations()
    with SessionLocal() as db:
        ensure_admin_user(db, settings)
        db.commit()
    print(json.dumps({"bootstrap": "ok", "database": settings.database_url.split("@")[-1]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
