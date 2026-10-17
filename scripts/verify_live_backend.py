"""Verify the running local API and configured Supabase demo without changing data.

Only password sign-ins create persistent cloud state (authentication sessions).
Never print response bodies, credentials, tokens, signed URLs, or exception text.
"""

import argparse
import base64
import ipaddress
import json
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from urllib.parse import quote, urlsplit
from uuid import UUID

import httpx
from dotenv import dotenv_values
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

from api.config import Settings

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".data" / "backend-live-verification.json"
LABELS = ("ORGANIZER", "CREW_A", "CREW_B")
COUNTS = {"reports": 10, "jobs": 6, "crews": 2, "photos": 10, "assignments": 5}
# SELECT policies can distinguish actions through storage.operation().
# https://supabase.com/docs/guides/storage/schema/helper-functions
STORAGE_READ_OPERATIONS = (
    "",
    "storage.object.get_authenticated",
    "storage.object.list",
    "storage.object.list_v2",
    "storage.object.sign",
    "storage.object.sign_many",
    "object.get_authenticated_info",
    "object.head_authenticated_info",
    "storage.render.image_authenticated",
)


class VerificationFailure(Exception):
    """A check failed; its fixed check name is the only public diagnostic."""


def require(condition):
    if not condition:
        raise VerificationFailure()


def loopback_url(value):
    """Normalize a loopback origin without retaining any user-supplied suffix."""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        local = host == "localhost" or ipaddress.ip_address(host).is_loopback
        if (
            not local
            or parsed.scheme not in ("http", "https")
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or parsed.port == 0
        ):
            raise ValueError()
        host = f"[{host}]" if ":" in host else host
        port = f":{parsed.port}" if parsed.port is not None else ""
        return f"{parsed.scheme}://{host}{port}"
    except (ValueError, TypeError):
        raise argparse.ArgumentTypeError(
            "Use an http(s) loopback origin, without credentials, path, or query."
        ) from None


@contextmanager
def read_connection(engine):
    with engine.connect() as connection:
        connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        connection.exec_driver_sql("SET LOCAL statement_timeout = '20s'")
        yield connection


class Verifier:
    def __init__(self, api, cloud, download, settings, credentials, report):
        self.api = api
        self.cloud = cloud
        self.download = download
        self.settings = settings
        self.credentials = credentials
        self.report = report
        self.tokens = {}
        self.jobs = {}

    @contextmanager
    def check(self, name):
        result = {"name": name, "status": "failed"}
        self.report["checks"].append(result)
        yield
        result["status"] = "passed"

    def request(self, client, method, path, *, status=200, **kwargs):
        response = client.request(method, path, **kwargs)
        require(response.status_code == status)
        return response

    def headers(self, label):
        return {"Authorization": "Bearer " + self.tokens[label]}

    def api_checks(self):
        with self.check("http_health_readiness_and_docs"):
            require(self.request(self.api, "GET", "/health").json()["status"] == "ok")
            require(self.request(self.api, "GET", "/ready").json()["status"] == "ready")
            self.request(self.api, "GET", "/docs")
        for label in LABELS:
            prefix = "DEMO_" + label
            with self.check("signin_and_role_" + label.lower()):
                result = self.request(
                    self.cloud,
                    "POST",
                    "/auth/v1/token?grant_type=password",
                    json={
                        "email": self.credentials[prefix + "_EMAIL"],
                        "password": self.credentials[prefix + "_PASSWORD"],
                    },
                ).json()
                require(result["user"]["id"] == self.credentials[prefix + "_USER_ID"])
                require(bool(result["user"]["email_confirmed_at"]))
                self.tokens[label] = result["access_token"]
                identity = self.request(
                    self.api, "GET", "/auth/me", headers=self.headers(label)
                ).json()
                require(identity["user_id"] == self.credentials[prefix + "_USER_ID"])
                require(
                    identity["role"]
                    == ("organizer" if label == "ORGANIZER" else "crew")
                )
                require(
                    identity["crew_id"] == self.credentials.get(prefix + "_CREW_ID")
                )
        with self.check("unauthenticated_and_invalid_sessions_denied"):
            for path in ("/auth/me", "/organizer/reports", "/jobs"):
                self.request(self.api, "GET", path, status=401)
            self.request(
                self.api,
                "GET",
                "/auth/me",
                headers={"Authorization": "Bearer deliberately-invalid"},
                status=401,
            )
        with self.check("organizer_report_listing"):
            reports = self.request(
                self.api, "GET", "/organizer/reports", headers=self.headers("ORGANIZER")
            ).json()
            require(len(reports) == COUNTS["reports"])
            require(all(row["illustrative"] for row in reports))
        with self.check("organizer_crews_and_seeded_plan"):
            crews = self.request(
                self.api, "GET", "/crews", headers=self.headers("ORGANIZER")
            ).json()
            require(len(crews) == COUNTS["crews"])
            current = self.request(
                self.api, "GET", "/plans/current", headers=self.headers("ORGANIZER")
            ).json()["plan"]
            require(current is not None and current["stale"] is False)
            require(len(current["assignments"]) == COUNTS["assignments"])
        for label, count in (("CREW_A", 3), ("CREW_B", 2)):
            with self.check("assigned_jobs_" + label.lower()):
                jobs = self.request(
                    self.api, "GET", "/jobs", headers=self.headers(label)
                ).json()
                require(len(jobs) == count)
                require(
                    all(
                        row["assigned_crew_id"]
                        == self.credentials["DEMO_" + label + "_CREW_ID"]
                        for row in jobs
                    )
                )
                self.jobs[label] = jobs
                self.request(
                    self.api,
                    "GET",
                    "/organizer/reports",
                    headers=self.headers(label),
                    status=403,
                )
        for label, other in (("CREW_A", "CREW_B"), ("CREW_B", "CREW_A")):
            with self.check("cross_crew_job_and_evidence_denied_" + label.lower()):
                path = "/jobs/" + str(UUID(self.jobs[other][0]["id"]))
                details = self.request(
                    self.api, "GET", path, headers=self.headers(other)
                ).json()
                require(bool(details["photo_ids"]))
                photo_path = "/photos/" + str(UUID(details["photo_ids"][0])) + "/access"
                self.request(
                    self.api, "GET", path, headers=self.headers(label), status=404
                )
                self.request(
                    self.api, "GET", photo_path, headers=self.headers(label), status=404
                )
                self.request(self.api, "GET", photo_path, status=401)
                with self.check("signed_photo_download_" + other.lower()):
                    access = self.request(
                        self.api, "GET", photo_path, headers=self.headers(other)
                    ).json()
                    self.verify_photo(access)

    def verify_photo(self, access):
        signed = httpx.URL(access["url"])
        origin = httpx.URL(self.settings.supabase_url)
        bucket = quote(self.settings.supabase_photo_bucket, safe="")
        prefix = "/storage/v1/object/sign/" + bucket + "/"
        require(
            (signed.scheme, signed.host, signed.port)
            == (origin.scheme, origin.host, origin.port)
            and not signed.userinfo
            and signed.path.startswith(prefix)
            and access["expires_in"] == self.settings.photo_url_ttl_seconds
        )
        # A separate client ensures downloads never carry the privileged API key.
        response = self.request(self.download, "GET", str(signed))
        require(response.headers.get("content-type", "").startswith("image/"))
        require(bool(response.content))
        public = signed.copy_with(
            path=signed.path.replace("/object/sign/", "/object/public/", 1),
            query=None,
            fragment=None,
        )
        response = self.download.get(public)
        require(response.status_code in (400, 401, 403, 404))

    def cloud_checks(self):
        with self.check("private_photo_bucket_limits"):
            bucket = quote(self.settings.supabase_photo_bucket, safe="")
            result = self.request(
                self.cloud, "GET", "/storage/v1/bucket/" + bucket
            ).json()
            require(result["public"] is False and result["file_size_limit"] == 8388608)
            require(
                set(result["allowed_mime_types"])
                == {"image/jpeg", "image/png", "image/webp"}
            )
        with self.check("private_schema_not_exposed_in_data_api"):
            response = self.request(
                self.cloud,
                "GET",
                "/rest/v1/",
                headers={"Accept-Profile": "wastegrid"},
                status=406,
            )
            require(response.json().get("code") == "PGRST106")
        with self.check("email_auth_enabled"):
            settings = self.request(self.cloud, "GET", "/auth/v1/settings").json()
            require(settings["external"]["email"] is True)

    def database_checks(self, engine):
        with read_connection(engine) as connection:
            with self.check("migration_checksums"):
                expected = {
                    path.name: sha256(path.read_bytes()).hexdigest()
                    for path in (ROOT / "supabase" / "migrations").glob("*.sql")
                }
                actual = dict(
                    connection.execute(
                        text("select name, checksum from wastegrid.schema_migrations")
                    ).all()
                )
                require(bool(expected) and actual == expected)
            with self.check("table_rls_and_client_privileges"):
                rows = connection.execute(
                    text(
                        "select c.relrowsecurity, "
                        "has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE'), "
                        "has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') "
                        "from pg_class c join pg_namespace n on n.oid=c.relnamespace "
                        "where n.nspname='wastegrid' and c.relkind='r'"
                    )
                ).all()
                require(
                    bool(rows) and all(rls and not a and not b for rls, a, b in rows)
                )
                for role in ("anon", "authenticated"):
                    require(
                        not connection.scalar(
                            text(
                                "select has_schema_privilege(:role,'wastegrid','USAGE')"
                            ),
                            {"role": role},
                        )
                    )

    def storage_policy_checks(self, engine):
        """Evaluate effective SELECT policies with each verified crew's JWT claims.

        This exercises PostgreSQL RLS, not the Storage HTTP gateway. Never use
        the privileged database role to judge what a crew can read. The role
        and claims changes are transaction-local and rolled back on exit.
        """
        for label in ("CREW_A", "CREW_B"):
            with self.check("storage_rls_denies_direct_reads_" + label.lower()):
                # api_checks already verified these sessions through /auth/me.
                payload = self.tokens[label].split(".")[1]
                claims = json.loads(
                    base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
                )
                require(claims["sub"] == self.credentials["DEMO_" + label + "_USER_ID"])
                require(claims["role"] == "authenticated")
                with read_connection(engine) as connection:
                    connection.execute(
                        text("select set_config('request.jwt.claims', :claims, true)"),
                        {"claims": json.dumps(claims)},
                    )
                    connection.exec_driver_sql("SET LOCAL ROLE authenticated")
                    require(
                        connection.scalar(text("select current_user"))
                        == "authenticated"
                    )
                    require(
                        connection.scalar(
                            text("select row_security_active('storage.objects')")
                        )
                    )
                    # Deny every object in this private bucket, including the
                    # other crew's photos. Permissive PUBLIC/member-role policies
                    # participate in the real RLS evaluation automatically.
                    for operation in STORAGE_READ_OPERATIONS:
                        connection.execute(
                            text(
                                "select set_config('storage.operation', :operation, true)"
                            ),
                            {"operation": operation},
                        )
                        require(
                            not connection.scalar(
                                text(
                                    "select exists(select 1 from storage.objects where bucket_id=:bucket)"
                                ),
                                {"bucket": self.settings.supabase_photo_bucket},
                            )
                        )


def snapshot(engine, bucket):
    """Fingerprint application rows and object metadata, excluding Auth sessions."""
    with read_connection(engine) as connection:
        tables = connection.execute(
            text("select tablename from pg_tables where schemaname='wastegrid'")
        ).scalars()
        quote_identifier = engine.dialect.identifier_preparer.quote
        sources = {
            name: "select * from wastegrid." + quote_identifier(name) for name in tables
        }
        sources["storage_objects"] = (
            "select id,bucket_id,name,metadata,created_at,updated_at "
            "from storage.objects where bucket_id=:bucket"
        )
        sources["storage_bucket"] = "select * from storage.buckets where id=:bucket"
        sources["auth_accounts"] = (
            "select id, email, email_confirmed_at from auth.users"
        )
        result = {}
        for name, query in sources.items():
            result[name] = tuple(
                connection.execute(
                    text(
                        "select count(*), md5(coalesce(string_agg("
                        "md5(row_to_json(t)::text), '' order by md5(row_to_json(t)::text)),'')) "
                        "from (" + query + ") t"
                    ),
                    {"bucket": bucket},
                ).one()
            )
        return result


def run(base_url, report):
    report["checks"].append({"name": "local_configuration", "status": "failed"})
    settings = Settings(_env_file=ROOT / ".env")
    credentials = dotenv_values(ROOT / ".env.supabase-demo", interpolate=False)
    require(bool(settings.database_url and settings.supabase_secret_key))
    cloud_url = urlsplit(settings.supabase_url)
    require(
        cloud_url.scheme == "https"
        and bool(cloud_url.hostname)
        and cloud_url.username is None
        and cloud_url.password is None
        and cloud_url.path in ("", "/")
        and not cloud_url.query
        and not cloud_url.fragment
    )
    for label in LABELS:
        for field in ("EMAIL", "PASSWORD", "USER_ID"):
            require(bool(credentials.get("DEMO_" + label + "_" + field)))
        UUID(credentials["DEMO_" + label + "_USER_ID"])
        if label != "ORGANIZER":
            UUID(credentials["DEMO_" + label + "_CREW_ID"])
    key = settings.supabase_secret_key.get_secret_value()
    headers = {"apikey": key}
    if not key.startswith("sb_secret_"):
        headers["Authorization"] = "Bearer " + key
    engine = create_engine(
        make_url(settings.database_url.get_secret_value()).set(
            drivername="postgresql+psycopg"
        ),
        connect_args={"connect_timeout": 10},
        hide_parameters=True,
    )
    report["checks"][-1]["status"] = "passed"
    try:
        with (
            httpx.Client(base_url=base_url, timeout=20, trust_env=False) as api,
            httpx.Client(
                base_url=settings.supabase_url,
                headers=headers,
                timeout=20,
                trust_env=False,
            ) as cloud,
            httpx.Client(timeout=20, trust_env=False) as download,
        ):
            verifier = Verifier(api, cloud, download, settings, credentials, report)
            with verifier.check("seeded_dataset_baseline"):
                before = snapshot(engine, settings.supabase_photo_bucket)
                require(all(before[name][0] == count for name, count in COUNTS.items()))
                report["counts"] = {name: before[name][0] for name in COUNTS}
            try:
                verifier.database_checks(engine)
                verifier.cloud_checks()
                verifier.api_checks()
                verifier.storage_policy_checks(engine)
            finally:
                with verifier.check("application_rows_and_storage_metadata_preserved"):
                    require(before == snapshot(engine, settings.supabase_photo_bucket))
    finally:
        engine.dispose()


def verify(base_url, evidence):
    """Run shared checks for an origin validated by a developer entry point."""
    report = {
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "base_url": base_url,
        "status": "failed",
        "checks": [],
        "preservation_scope": "application rows, Auth account identities, Storage bucket and object metadata; photo bytes are not compared",
    }
    try:
        run(base_url, report)
        report["status"] = "passed"
    except Exception as error:
        # Exception strings, HTTP bodies and URLs can contain credentials.
        report["error_kind"] = (
            "request_error"
            if isinstance(error, httpx.HTTPError)
            else (
                "database_error"
                if isinstance(error, SQLAlchemyError)
                else "check_failed"
            )
        )
    report["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
    try:
        evidence.parent.mkdir(exist_ok=True)
        evidence.write_text(json.dumps(report, indent=2) + "\n")
    except OSError:
        print("FAIL: unable to save local verification evidence.")
        return 1
    for check in report["checks"]:
        print(f"{check['status'].upper()}: {check['name']}")
    print(f"Result: {report['status']}. Evidence: {evidence}")
    return 0 if report["status"] == "passed" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url", type=loopback_url, default="http://127.0.0.1:8000"
    )
    args = parser.parse_args(argv)
    return verify(args.base_url, EVIDENCE)


if __name__ == "__main__":
    raise SystemExit(main())
