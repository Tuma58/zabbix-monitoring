"""Add monitoring fields to devices."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "002_device_monitoring_fields"
down_revision = "001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.add_column(sa.Column("protocol", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("monitoring_subtype", sa.String(length=64), nullable=True))
        batch_op.add_column(
            sa.Column(
                "credential_profile_id",
                sa.String(length=36),
                sa.ForeignKey("credential_profiles.id"),
                nullable=True,
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("devices") as batch_op:
        batch_op.drop_column("credential_profile_id")
        batch_op.drop_column("monitoring_subtype")
        batch_op.drop_column("protocol")
