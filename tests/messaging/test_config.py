from pathlib import Path

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
