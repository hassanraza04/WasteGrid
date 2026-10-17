"""Exercise the local check through the real gateway client with mocked HTTP."""

import base64
import json

import httpx
import pytest
from PIL import Image

from api.config import Settings
from scripts import check_chalk_assessment as check
from tests.test_assessment import assessment


@pytest.fixture
def photo(tmp_path):
    path = tmp_path / "synthetic.png"
    Image.new("RGB", (12, 12), "green").save(path)
    return path


@pytest.mark.parametrize("failure", [None, "http", "invalid", "timeout"])
@pytest.mark.parametrize("effort", [None, "none"])
def test_local_check_sends_one_photo_request(
    monkeypatch, photo, capsys, failure, effort
):
    settings = Settings(
        _env_file=None,
        chalk_router_api_key="private-test-key",
        chalk_env_id="test-env",
        chalk_model="xai/grok-4.3",
        chalk_reasoning_effort=effort,
    )
    monkeypatch.setattr(check, "Settings", lambda: settings)
    requests = []

    def handle(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer private-test-key"
        assert request.headers["X-Chalk-Env-Id"] == "test-env"
        body = json.loads(request.content)
        assert body["model"] == "xai/grok-4.3"
        if effort is None:
            assert "reasoning_effort" not in body
        else:
            assert body["reasoning_effort"] == effort
        parts = body["messages"][1]["content"]
        data_url = parts[1]["image_url"]["url"]
        assert data_url.startswith("data:image/png;base64,")
        assert base64.b64decode(data_url.split(",", 1)[1]) == photo.read_bytes()
        context = json.loads(parts[0]["text"])
        assert context["location"]["latitude"] == 24.92
        assert context["resident_answers"] == {"fire": False, "sharp_objects": False}
        assert context["resident_note"] == "Mixed waste"
        if failure == "http":
            return httpx.Response(401, json={"error": "private-test-key"})
        if failure == "timeout":
            raise httpx.ReadTimeout("private-test-key")
        content = "not JSON" if failure == "invalid" else assessment().model_dump_json()
        return httpx.Response(
            200, json={"choices": [{"message": {"content": content}}]}
        )

    real_client = httpx.Client
    monkeypatch.setattr(
        "api.integrations.httpx.Client",
        lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(handle)),
    )
    code = check.main(
        [
            str(photo),
            "--note",
            "Mixed waste",
            "--latitude",
            "24.92",
            "--longitude",
            "67.09",
            "--fire",
            "no",
            "--sharp-objects",
            "no",
        ]
    )
    assert code == (1 if failure else 0)
    assert len(requests) == 1
    output = capsys.readouterr()
    assert "private-test-key" not in output.out + output.err
    if not failure:
        data = json.loads(output.out)
        assert data["assessment"]["description"] == "Mixed bags and rubble"
        assert data["priority"] == "routine" and not data["needs_review"]
        assert data["elapsed_seconds"] >= 0


def test_missing_credentials_make_no_request(monkeypatch, capsys):
    monkeypatch.setattr(check, "Settings", lambda: Settings(_env_file=None))
    monkeypatch.setattr(
        check,
        "ChalkAssessmentClient",
        lambda *args: pytest.fail("must not call gateway"),
    )
    assert check.main(["missing.jpg"]) == 2
    assert "CHALK_ROUTER_API_KEY" in capsys.readouterr().err


def test_invalid_photo_makes_no_request(monkeypatch, tmp_path):
    monkeypatch.setattr(
        check,
        "Settings",
        lambda: Settings(
            _env_file=None,
            chalk_router_api_key="private-test-key",
            chalk_env_id="test-env",
            chalk_model="xai/grok-4.3",
        ),
    )
    monkeypatch.setattr(
        check,
        "ChalkAssessmentClient",
        lambda *args: pytest.fail("must not call gateway"),
    )
    path = tmp_path / "invalid.png"
    path.write_text("not an image")
    assert check.main([str(path)]) == 2
