"""Public map bounds must not become an exact-location oracle."""

from sqlalchemy.dialects import postgresql

from api.config import Settings
from api.main import create_app


class FakeResult:
    def all(self):
        return [(24.921, 67.091)]


class FakeDb:
    query = None

    def execute(self, query):
        self.query = query
        return FakeResult()


def test_public_map_filters_and_returns_only_rounded_coordinates():
    app = create_app(Settings(_env_file=None))
    try:
        endpoint = next(
            route.endpoint
            for route in app.routes
            if getattr(route, "path", None) == "/map/markers"
        )
        db = FakeDb()
        result = endpoint(
            south=24.9209, north=24.9211, west=67.0909, east=67.0911, db=db
        )
        assert result.model_dump() == {
            "items": [{"latitude": 24.921, "longitude": 67.091}],
            "truncated": False,
        }
        query = str(db.query.compile(dialect=postgresql.dialect())).lower()
        # Both selected coordinates and both viewport predicates use round().
        assert query.count("round(") == 4
        assert "reports.title" not in query
        assert "reports.public_reference" not in query
    finally:
        app.state.cloud.close()
