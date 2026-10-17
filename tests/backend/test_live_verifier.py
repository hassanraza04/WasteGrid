"""Failure, privacy, and read-only checks for the developer live verifier."""

import argparse
import json
from contextlib import ExitStack
from uuid import UUID

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from api.config import Settings
from scripts import verify_live_backend as live


def uid(number):
    return str(UUID(int=number))


def mock_verifier(stack, report, failure=None):
    credentials = {}
    for index, label in enumerate(live.LABELS, 1):
        prefix = "DEMO_" + label
        credentials[prefix + "_EMAIL"] = label.lower() + "@example.com"
        credentials[prefix + "_PASSWORD"] = "private-password-" + label
        credentials[prefix + "_USER_ID"] = uid(index)
        if index > 1:
            credentials[prefix + "_CREW_ID"] = uid(index + 10)

    def api_handler(request):
        assert request.method == "GET", "Verifier must not change API data"
        if failure == "unavailable_api":
            raise httpx.ConnectError("private-exception-token", request=request)
        path = request.url.path
        if path in ("/health", "/ready", "/docs"):
            return httpx.Response(
                200, json={"status": "ready" if path == "/ready" else "ok"}
            )
        label = request.headers.get("authorization", "").removeprefix(
            "Bearer private-jwt-"
        )
        if label not in live.LABELS:
            return httpx.Response(401, json={"detail": "private-error-body"})
        if path == "/auth/me":
            return httpx.Response(
                200,
                json={
                    "user_id": credentials["DEMO_" + label + "_USER_ID"],
                    "role": "organizer" if label == "ORGANIZER" else "crew",
                    "crew_id": credentials.get("DEMO_" + label + "_CREW_ID"),
                },
            )
        if path == "/organizer/reports":
            return (
                httpx.Response(200, json=[{"illustrative": True}] * 10)
                if label == "ORGANIZER"
                else httpx.Response(403)
            )
        if path == "/jobs":
            start, count = (20, 3) if label == "CREW_A" else (30, 2)
            return httpx.Response(
                200,
                json=[
                    {
                        "id": uid(start + i),
                        "assigned_crew_id": credentials["DEMO_" + label + "_CREW_ID"],
                    }
                    for i in range(count)
                ],
            )
        identifier = int(UUID(path.split("/")[2]))
        owner = "CREW_A" if identifier in (20, 120) else "CREW_B"
        if label != owner:
            return httpx.Response(200 if failure == "unexpected_authorization" else 404)
        if path.startswith("/jobs/"):
            return httpx.Response(200, json={"photo_ids": [uid(identifier + 100)]})
        return httpx.Response(
            200,
            json={
                "url": f"https://demo.supabase.co/storage/v1/object/sign/report-photos/{identifier}?token=private-signed-token",
                "expires_in": 300,
            },
        )

    def cloud_handler(request):
        assert request.headers["apikey"] == "sb_secret_private"
        assert "authorization" not in request.headers
        if request.method == "POST":
            assert request.url.path == "/auth/v1/token"
            assert request.url.params["grant_type"] == "password"
            if failure == "failed_login":
                return httpx.Response(
                    400, json={"detail": "private-password-from-server"}
                )
            body = json.loads(request.content)
            label = body["email"].split("@")[0].upper()
            return httpx.Response(
                200,
                json={
                    "access_token": "private-jwt-" + label,
                    "user": {
                        "id": credentials["DEMO_" + label + "_USER_ID"],
                        "email_confirmed_at": "2026-10-17T00:00:00Z",
                    },
                },
            )
        assert request.method == "GET"
        if request.url.path == "/rest/v1/":
            assert request.headers["accept-profile"] == "wastegrid"
            return httpx.Response(406, json={"code": "PGRST106"})
        if request.url.path == "/auth/v1/settings":
            return httpx.Response(200, json={"external": {"email": True}})
        return httpx.Response(
            200,
            json={
                "public": False,
                "file_size_limit": 8388608,
                "allowed_mime_types": ["image/jpeg", "image/png", "image/webp"],
            },
        )

    def download_handler(request):
        assert request.method == "GET"
        assert (
            "apikey" not in request.headers and "authorization" not in request.headers
        )
        if "/public/" in request.url.path:
            assert not request.url.query
            return httpx.Response(200 if failure == "public_photo" else 404)
        return httpx.Response(
            200, content=b"fixture", headers={"content-type": "image/png"}
        )

    api = stack.enter_context(
        httpx.Client(
            base_url="http://127.0.0.1:8000", transport=httpx.MockTransport(api_handler)
        )
    )
    cloud = stack.enter_context(
        httpx.Client(
            base_url="https://demo.supabase.co",
            headers={"apikey": "sb_secret_private"},
            transport=httpx.MockTransport(cloud_handler),
        )
    )
    download = stack.enter_context(
        httpx.Client(transport=httpx.MockTransport(download_handler))
    )
    settings = Settings(_env_file=None, supabase_url="https://demo.supabase.co")
    return live.Verifier(api, cloud, download, settings, credentials, report)


@pytest.mark.parametrize(
    "failure",
    [
        None,
        "unavailable_api",
        "failed_login",
        "unexpected_authorization",
        "public_photo",
    ],
)
def test_cli_results_and_diagnostics_are_secret_free(
    failure, tmp_path, monkeypatch, capsys
):
    def run(base_url, report):
        with ExitStack() as stack:
            verifier = mock_verifier(stack, report, failure)
            verifier.cloud_checks()
            verifier.api_checks()

    evidence = tmp_path / "evidence.json"
    monkeypatch.setattr(live, "EVIDENCE", evidence)
    monkeypatch.setattr(live, "run", run)
    assert live.main([]) == (1 if failure else 0)
    captured = capsys.readouterr()
    serialized = evidence.read_text()
    assert "private-" not in serialized + captured.out + captured.err
    assert "sb_secret_" not in serialized + captured.out + captured.err
    result = json.loads(serialized)
    assert result["status"] == ("failed" if failure else "passed")
    assert any(check["status"] == "failed" for check in result["checks"]) == bool(
        failure
    )
    assert result["started_at_utc"] <= result["finished_at_utc"]


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "http://192.168.1.1:8000",
        "http://127.0.0.1.example.com",
        "http://localhost@evil.example",
        "http://user:private-password@localhost",
        "http://localhost/path",
        "http://localhost?token=private-token",
        "http://localhost#private-token",
        "file:///tmp/test",
        "http://localhost:0",
        "http://localhost:65536",
        "http://localhost:invalid",
    ],
)
def test_remote_or_credential_bearing_origins_rejected(url):
    with pytest.raises(argparse.ArgumentTypeError) as error:
        live.loopback_url(url)
    assert "private-" not in str(error.value)


@pytest.mark.parametrize(
    "url", ["http://127.0.0.1:8000", "http://localhost:8000", "http://[::1]:8000"]
)
def test_loopback_origins_accepted(url):
    assert live.loopback_url(url + "/") == url


def test_signed_photo_cannot_redirect_credentials_or_leave_project():
    with ExitStack() as stack:
        verifier = mock_verifier(stack, {"checks": []})
        for url in [
            "https://evil.example/photo?token=private-signed-token",
            "https://demo.supabase.co:444/storage/v1/object/sign/report-photos/a",
        ]:
            with pytest.raises(live.VerificationFailure):
                verifier.verify_photo({"url": url, "expires_in": 300})


def test_database_reads_and_fingerprints(engine, seeded):
    # The existing engine fixture only permits disposable localhost databases.
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "alter table auth.users add column email text, add column email_confirmed_at timestamptz"
        )
        connection.exec_driver_sql(
            "create table storage.objects(id uuid, bucket_id text, name text, metadata json, created_at timestamptz, updated_at timestamptz)"
        )
    with ExitStack() as stack:
        verifier = mock_verifier(stack, {"checks": []})
        verifier.database_checks(engine)
    before = live.snapshot(engine, "report-photos")
    with pytest.raises(DBAPIError):
        with live.read_connection(engine) as connection:
            connection.exec_driver_sql(
                "update wastegrid.crews set name='must not persist'"
            )
    assert live.snapshot(engine, "report-photos") == before
    with engine.begin() as connection:
        connection.execute(
            text("update wastegrid.crews set name='changed for fingerprint check'")
        )
    assert live.snapshot(engine, "report-photos") != before
