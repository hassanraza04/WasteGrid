"""Backend proximity policy for unresolved reports; not image-based identity."""

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from api.models import Job, Report
from api.schemas import Location
from api.workflows import distance_km


def nearby_open_report(
    db: Session, location: Location | None, radius_meters: float
) -> Report | None:
    if location is None or radius_meters <= 0:
        return None
    # A latitude band cheaply filters candidates. Exact haversine distance handles
    # longitude wrap and polar locations without a GIS service or extension.
    latitude = Report.location["latitude"].as_float()
    band = radius_meters / 110_000
    candidates = db.scalars(
        select(Report)
        .outerjoin(Job, Report.job_id == Job.id)
        .where(
            latitude.between(location.latitude - band, location.latitude + band),
            or_(Report.job_id.is_(None), Job.status != "completed"),
        )
        .order_by(Report.created_at, Report.id)
    )
    target = location.model_dump()
    for report in candidates:
        if (
            report.location
            and distance_km(target, report.location) * 1000 <= radius_meters
        ):
            return report
    return None
