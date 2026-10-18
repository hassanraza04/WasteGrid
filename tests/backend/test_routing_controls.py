"""PostgreSQL coverage for resource enforcement and durable partial dispatch."""

import pytest

from tests.test_routing_controls import (
    verify_execution_resource_change,
    verify_partial_dispatch,
    verify_resource_change,
)


def test_postgres_partial_dispatch_freezes_consent_and_unassigned_outcome(engine):
    verify_partial_dispatch(engine)


@pytest.mark.parametrize("change", ["equipment", "shift", "required_equipment"])
def test_postgres_resource_changes_invalidate_even_without_version_increment(
    engine, change
):
    verify_resource_change(engine, change)


@pytest.mark.parametrize("change", ["equipment", "shift", "required_equipment"])
def test_postgres_start_validates_frozen_remaining_route_constraints(engine, change):
    verify_execution_resource_change(engine, change)
