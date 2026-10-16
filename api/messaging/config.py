"""Local configuration for the Photon Beta integration."""

from dataclasses import dataclass
from typing import Mapping


class ConfigurationError(ValueError):
    """Raised when a required Photon configuration value is absent or invalid."""


@dataclass(frozen=True)
class PhotonConfig:
    """Configuration values that are safe to pass within the local process."""

    project_id: str
    api_key: str
    poll_interval_seconds: float


def load_photon_config(environ: Mapping[str, str]) -> PhotonConfig:
    """Load Photon configuration without exposing secret values in error messages."""
    project_id = environ.get("PHOTON_PROJECT_ID", "").strip()
    if not project_id:
        raise ConfigurationError("PHOTON_PROJECT_ID must be set")

    api_key = environ.get("PHOTON_API_KEY", "").strip()
    if not api_key:
        raise ConfigurationError("PHOTON_API_KEY must be set")

    interval_text = environ.get("PHOTON_POLL_INTERVAL_SECONDS", "2")
    try:
        poll_interval_seconds = float(interval_text)
    except ValueError as error:
        raise ConfigurationError("PHOTON_POLL_INTERVAL_SECONDS must be a number") from error

    if poll_interval_seconds <= 0:
        raise ConfigurationError("PHOTON_POLL_INTERVAL_SECONDS must be greater than zero")

    return PhotonConfig(
        project_id=project_id,
        api_key=api_key,
        poll_interval_seconds=poll_interval_seconds,
    )
