"""Add system_settings table for portal configuration."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "003_system_settings"
down_revision = "002_device_monitoring_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "system_settings",
        sa.Column("key", sa.String(length=128), primary_key=True),
        sa.Column("value_json", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.String(length=36), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("system_settings")
