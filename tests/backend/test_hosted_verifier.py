"""The hosted entry point is pinned and preserves shared failure/privacy rules."""

import json
from contextlib import ExitStack

import pytest

from scripts import verify_hosted_backend as hosted
from scripts import verify_live_backend as live
from tests.backend.test_live_verifier import mock_verifier


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
def test_hosted_results_and_diagnostics(failure, tmp_path, monkeypatch, capsys):
    def run(base_url, report):
        assert base_url == "https://wastegrid-api-dev.onrender.com"
        with ExitStack() as stack:
            verifier = mock_verifier(stack, report, failure)
            verifier.cloud_checks()
            verifier.api_checks()

    evidence = tmp_path / "backend-hosted-render-verification.json"
    monkeypatch.setattr(live, "run", run)
    monkeypatch.setattr(hosted, "EVIDENCE", evidence)
    assert hosted.main([]) == (1 if failure else 0)
    captured = capsys.readouterr()
    serialized = evidence.read_text()
    assert "private-" not in serialized + captured.out + captured.err
    assert "sb_secret_" not in serialized + captured.out + captured.err
    result = json.loads(serialized)
    assert result["base_url"] == hosted.HOSTED_API_URL
    assert result["status"] == ("failed" if failure else "passed")
    assert result["started_at_utc"] <= result["finished_at_utc"]
    assert any(check["status"] == "failed" for check in result["checks"]) == bool(
        failure
    )


@pytest.mark.parametrize("argument", ["--base-url", "--password"])
def test_hosted_destination_and_credentials_cannot_be_supplied(argument, monkeypatch):
    def unexpected_run(*args):
        pytest.fail("Rejected arguments must not start verification")

    monkeypatch.setattr(live, "run", unexpected_run)
    with pytest.raises(SystemExit) as error:
        hosted.main([argument, "https://unconfigured.invalid"])
    assert error.value.code == 2


def test_hosted_evidence_write_failure_is_sanitized(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(live, "run", lambda *args: None)
    monkeypatch.setattr(hosted, "EVIDENCE", tmp_path)
    assert hosted.main([]) == 1
    captured = capsys.readouterr()
    assert captured.out == "FAIL: unable to save local verification evidence.\n"
    assert not captured.err
