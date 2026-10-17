"""Local configuration for the Photon Beta integration."""

from dataclasses import dataclass
import ipaddress
from math import isfinite
from pathlib import Path
import re
from typing import Mapping
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    """Raised when a required Photon configuration value is absent or invalid."""


@dataclass(frozen=True)
class PhotonConfig:
    """Configuration values that are safe to pass within the local process."""

    project_id: str
    api_key: str
    backend: "BackendConfig"
    poll_interval_seconds: float
    delivery_db_path: Path


@dataclass(frozen=True)
class BackendConfig:
    """Credentials and request settings for the Wastegrid backend."""

    base_url: str
    messaging_api_key: str
    agent_sender_id: str
    timeout_seconds: float


def _is_valid_host(hostname: str) -> bool:
    if ":" in hostname:
        try:
            ipaddress.IPv6Address(hostname)
        except ValueError:
            return False
        return True

    try:
        ascii_hostname = hostname.encode("idna").decode("ascii")
    except UnicodeError:
        return False

    if len(ascii_hostname) > 253:
        return False
    labels = ascii_hostname.rstrip(".").split(".")
    return bool(labels) and all(
        0 < len(label) <= 63
        and re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", label)
        for label in labels
    )


def load_photon_config(environ: Mapping[str, str]) -> PhotonConfig:
    """Load Photon configuration without exposing secret values in error messages."""
    project_id = environ.get("PHOTON_PROJECT_ID", "").strip()
    if not project_id:
        raise ConfigurationError("PHOTON_PROJECT_ID must be set")

    api_key = environ.get("PHOTON_API_KEY", "").strip()
    if not api_key:
        raise ConfigurationError("PHOTON_API_KEY must be set")

    backend_url = environ.get("WASTEGRID_BACKEND_URL", "").strip()
    try:
        parsed_backend_url = urlsplit(backend_url)
        valid_backend_url = (
            parsed_backend_url.scheme in {"http", "https"}
            and bool(parsed_backend_url.hostname)
            and _is_valid_host(parsed_backend_url.hostname)
            and parsed_backend_url.username is None
            and parsed_backend_url.password is None
            and not parsed_backend_url.query
            and not parsed_backend_url.fragment
            and "?" not in backend_url
            and "#" not in backend_url
        )
        parsed_backend_url.port
    except ValueError:
        valid_backend_url = False
    if not valid_backend_url:
        raise ConfigurationError("WASTEGRID_BACKEND_URL must be a safe HTTP(S) URL")

    messaging_api_key = environ.get("WASTEGRID_MESSAGING_API_KEY", "").strip()
    if not messaging_api_key:
        raise ConfigurationError("WASTEGRID_MESSAGING_API_KEY must be set")

    agent_sender_id = environ.get("PHOTON_AGENT_SENDER_ID", "").strip()
    if not agent_sender_id:
        raise ConfigurationError("PHOTON_AGENT_SENDER_ID must be set")

    timeout_text = environ.get("WASTEGRID_TIMEOUT_SECONDS", "10")
    try:
        timeout_seconds = float(timeout_text)
    except ValueError as error:
        raise ConfigurationError("WASTEGRID_TIMEOUT_SECONDS must be a number") from error
    if not isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ConfigurationError(
            "WASTEGRID_TIMEOUT_SECONDS must be greater than zero"
        )

    interval_text = environ.get("PHOTON_POLL_INTERVAL_SECONDS", "2")
    try:
        poll_interval_seconds = float(interval_text)
    except ValueError as error:
        raise ConfigurationError(
            "PHOTON_POLL_INTERVAL_SECONDS must be a number"
        ) from error

    if poll_interval_seconds <= 0:
        raise ConfigurationError(
            "PHOTON_POLL_INTERVAL_SECONDS must be greater than zero"
        )

    return PhotonConfig(
        project_id=project_id,
        api_key=api_key,
        backend=BackendConfig(
            base_url=backend_url.rstrip("/"),
            messaging_api_key=messaging_api_key,
            agent_sender_id=agent_sender_id,
            timeout_seconds=timeout_seconds,
        ),
        poll_interval_seconds=poll_interval_seconds,
        delivery_db_path=Path(
            environ.get("PHOTON_DELIVERY_DB_PATH", ".data/photon-delivery.db")
        ).expanduser(),
    )
