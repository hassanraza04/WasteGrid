from io import BytesIO

import httpx
import pytest
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

from api.config import Settings
from api.storage import SupabaseCloud, read_photo


def test_supabase_http_contract_and_secret_headers():
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path == "/auth/v1/user":
            assert request.headers["Authorization"] == "Bearer user-jwt"
            return httpx.Response(
                200, json={"id": "10000000-0000-4000-8000-000000000001"}
            )
        assert "Authorization" not in request.headers
        if "/object/sign/" in request.url.path:
            return httpx.Response(
                200, json={"signedURL": "/object/sign/report-photos/test?token=test"}
            )
        return httpx.Response(200, json={})

    cloud = SupabaseCloud(
        Settings(
            _env_file=None,
            supabase_url="https://example.supabase.co",
            supabase_secret_key="sb_secret_test",
        )
    )
    cloud.client.close()
    cloud.client = httpx.Client(transport=httpx.MockTransport(handler))
    cloud.user_id("user-jwt")
    cloud.upload("test", b"png", "image/png")
    assert (
        cloud.signed_url("test")
        == "https://example.supabase.co/storage/v1/object/sign/report-photos/test?token=test"
    )
    cloud.delete("test")
    assert all(r.headers["apikey"] == "sb_secret_test" for r in calls)
    assert [r.method for r in calls] == ["GET", "POST", "POST", "DELETE"]
    assert calls[1].headers["x-upsert"] == "false"
    cloud.close()


def test_provider_errors_do_not_expose_secret_response():
    cloud = SupabaseCloud(
        Settings(
            _env_file=None,
            supabase_url="https://example.supabase.co",
            supabase_secret_key="legacy-key",
        )
    )
    cloud.client.close()
    cloud.client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                500, json={"detail": "private-provider-secret"}
            )
        )
    )
    with pytest.raises(HTTPException) as error:
        cloud.user_id("bad-jwt")
    assert error.value.status_code == 503
    assert "private-provider-secret" not in str(error.value)
    cloud.close()


def test_declared_image_type_must_match_bytes(png):
    upload = UploadFile(BytesIO(png), headers=Headers({"content-type": "image/jpeg"}))
    with pytest.raises(HTTPException) as error:
        read_photo(upload, 8388608)
    assert error.value.status_code == 415
