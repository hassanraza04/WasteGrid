import pytest

from api.messaging.config import ConfigurationError, load_photon_config


def test_load_photon_config_requires_project_id() -> None:
    with pytest.raises(ConfigurationError, match="PHOTON_PROJECT_ID"):
        load_photon_config({"PHOTON_API_KEY": "pho_sk_test"})


def test_load_photon_config_requires_api_key() -> None:
    with pytest.raises(ConfigurationError, match="PHOTON_API_KEY"):
        load_photon_config({"PHOTON_PROJECT_ID": "pho_prj_test"})


def test_load_photon_config_reads_values_and_default_interval() -> None:
    config = load_photon_config(
        {
            "PHOTON_PROJECT_ID": "pho_prj_test",
            "PHOTON_API_KEY": "pho_sk_test",
        }
    )

    assert config.project_id == "pho_prj_test"
    assert config.api_key == "pho_sk_test"
    assert config.poll_interval_seconds == 2.0


def test_load_photon_config_rejects_non_positive_poll_interval() -> None:
    with pytest.raises(ConfigurationError, match="PHOTON_POLL_INTERVAL_SECONDS"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "PHOTON_POLL_INTERVAL_SECONDS": "0",
            }
        )


def test_load_photon_config_rejects_non_numeric_poll_interval() -> None:
    with pytest.raises(ConfigurationError, match="PHOTON_POLL_INTERVAL_SECONDS"):
        load_photon_config(
            {
                "PHOTON_PROJECT_ID": "pho_prj_test",
                "PHOTON_API_KEY": "pho_sk_test",
                "PHOTON_POLL_INTERVAL_SECONDS": "soon",
            }
        )
