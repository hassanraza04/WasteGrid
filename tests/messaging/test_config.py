from pathlib import Path
import traceback

import pytest

from api.messaging.config import ConfigurationError, load_photon_config


def test_load_photon_config_requires_project_id() -> None:
    with pytest.raises(ConfigurationError, match="PHOTON_PROJECT_ID"):
        load_photon_config({"PHOTON_API_KEY": "pho_sk_test"})


def test_load_photon_config_requires_api_key() -> None:
    with pytest.raises(ConfigurationError, match="PHOTON_API_KEY"):
        load_photon_config({"PHOTON_PROJECT_ID": "pho_prj_test"})


def test_load_photon_config_requires_backend_credentials() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {"PHOTON_PROJECT_ID": "pho_prj_test", "PHOTON_API_KEY": "pho_sk_test"}
        )


def test_load_photon_config_rejects_unsafe_backend_url() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://key@example.test/api?secret=yes",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


def test_load_photon_config_rejects_backend_url_with_malformed_host() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://bad host/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


def test_load_photon_config_rejects_backend_url_with_repeated_trailing_dots() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test../api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


@pytest.mark.parametrize(
    "url",
    ["\thttps://backend.example.test/api", "https://backend.example.test/api\n"],
)
def test_load_photon_config_rejects_backend_url_with_edge_whitespace(url: str) -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": url,
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


def test_load_photon_config_rejects_backend_url_with_path_whitespace() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test/api path",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


def test_load_photon_config_rejects_backend_url_with_unicode_control_character() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test/api\u0080path",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


@pytest.mark.parametrize("control_character", ["\n", "\t"])
def test_load_photon_config_rejects_backend_url_with_control_character(
    control_character: str,
) -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": f"https://bad{control_character}host/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


@pytest.mark.parametrize(
    "url",
    ["https://backend.example.test/api?", "https://backend.example.test/api#"],
)
def test_load_photon_config_rejects_empty_query_and_fragment(url: str) -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": url,
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


def test_load_photon_config_rejects_malformed_backend_port() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test:bad/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


@pytest.mark.parametrize("timeout", ["nan", "inf", "-inf"])
def test_load_photon_config_rejects_non_finite_timeout(timeout: str) -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_TIMEOUT_SECONDS"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
                "WASTEGRID_TIMEOUT_SECONDS": timeout,
            }
        )


def test_load_photon_config_does_not_chain_invalid_timeout_value() -> None:
    secret_timeout = "timeout-secret-value"
    with pytest.raises(ConfigurationError, match="WASTEGRID_TIMEOUT_SECONDS") as error:
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
                "WASTEGRID_TIMEOUT_SECONDS": secret_timeout,
            }
        )

    assert error.value.__cause__ is None
    assert error.value.__context__ is None
    assert not error.value.__suppress_context__
    assert secret_timeout not in "".join(traceback.format_exception(error.value))


def test_load_photon_config_does_not_chain_invalid_poll_interval_value() -> None:
    secret_interval = "interval-secret-value"
    with pytest.raises(
        ConfigurationError, match="PHOTON_POLL_INTERVAL_SECONDS"
    ) as error:
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
                "PHOTON_POLL_INTERVAL_SECONDS": secret_interval,
            }
        )

    assert error.value.__cause__ is None
    assert error.value.__context__ is None
    assert not error.value.__suppress_context__
    assert secret_interval not in "".join(traceback.format_exception(error.value))


@pytest.mark.parametrize(
    ("name", "environment"),
    [
        ("WASTEGRID_BACKEND_URL", {}),
        (
            "WASTEGRID_MESSAGING_API_KEY",
            {"WASTEGRID_BACKEND_URL": "https://backend.example.test/api"},
        ),
        (
            "PHOTON_AGENT_SENDER_ID",
            {
                "WASTEGRID_BACKEND_URL": "https://backend.example.test/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
            },
        ),
    ],
)
def test_load_photon_config_requires_backend_settings(
    name: str, environment: dict[str, str]
) -> None:
    with pytest.raises(ConfigurationError, match=name):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                **environment,
            }
        )


def test_load_photon_config_reads_values_and_default_interval() -> None:
    config = load_photon_config(
        {
            "PHOTON_PROJECT_ID": "pho_prj_test",
            "PHOTON_API_KEY": "pho_sk_test",
            "WASTEGRID_BACKEND_URL": "https://backend.example.test/api",
            "WASTEGRID_MESSAGING_API_KEY": "backend-key",
            "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
        }
    )

    assert config.project_id == "pho_prj_test"
    assert config.api_key == "pho_sk_test"
    assert config.backend.base_url == "https://backend.example.test/api"
    assert config.backend.messaging_api_key == "backend-key"
    assert config.backend.agent_sender_id == "pho_usr_agent"
    assert config.backend.timeout_seconds == 10.0
    assert config.poll_interval_seconds == 2.0
    assert config.delivery_db_path == Path(".data/photon-delivery.db")


def test_load_photon_config_reads_delivery_db_path() -> None:
    config = load_photon_config(
        {
            "PHOTON_PROJECT_ID": "pho_prj_test",
            "PHOTON_API_KEY": "pho_sk_test",
            "PHOTON_DELIVERY_DB_PATH": "/tmp/ledger.db",
            "WASTEGRID_BACKEND_URL": "https://backend.example.test/api",
            "WASTEGRID_MESSAGING_API_KEY": "backend-key",
            "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
        }
    )

    assert config.delivery_db_path == Path("/tmp/ledger.db")


def test_load_photon_config_rejects_non_positive_poll_interval() -> None:
    with pytest.raises(ConfigurationError, match="PHOTON_POLL_INTERVAL_SECONDS"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "PHOTON_POLL_INTERVAL_SECONDS": "0",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )


def test_load_photon_config_rejects_non_numeric_poll_interval() -> None:
    with pytest.raises(ConfigurationError, match="PHOTON_POLL_INTERVAL_SECONDS"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "PHOTON_POLL_INTERVAL_SECONDS": "soon",
                "WASTEGRID_BACKEND_URL": "https://backend.example.test/api",
                "WASTEGRID_MESSAGING_API_KEY": "backend-key",
                "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
            }
        )
