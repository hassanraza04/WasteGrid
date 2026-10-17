"""Local configuration for the Photon Beta integration."""

import ipaddress
import json
import re
import unicodedata
from dataclasses import dataclass
from math import isfinite
from pathlib import Path
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
    pilot_enabled: bool = False
    pilot_chat_ids: tuple[str, ...] = ()


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
    labels = ascii_hostname.removesuffix(".").split(".")
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

    raw_backend_url = environ.get("WASTEGRID_BACKEND_URL", "")
    backend_url = raw_backend_url.strip()
    if any(
        character.isspace() or unicodedata.category(character).startswith("C")
        for character in raw_backend_url
    ):
        raise ConfigurationError("WASTEGRID_BACKEND_URL must be a safe HTTP(S) URL")
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
    invalid_timeout = False
    try:
        timeout_seconds = float(timeout_text)
    except ValueError:
        invalid_timeout = True
    if invalid_timeout:
        raise ConfigurationError("WASTEGRID_TIMEOUT_SECONDS must be a number")
    if not isfinite(timeout_seconds) or timeout_seconds <= 0:
        raise ConfigurationError("WASTEGRID_TIMEOUT_SECONDS must be greater than zero")

    interval_text = environ.get("PHOTON_POLL_INTERVAL_SECONDS", "2")
    invalid_interval = False
    try:
        poll_interval_seconds = float(interval_text)
    except ValueError:
        invalid_interval = True
    if invalid_interval:
        raise ConfigurationError("PHOTON_POLL_INTERVAL_SECONDS must be a number")

    if not isfinite(poll_interval_seconds) or poll_interval_seconds <= 0:
        raise ConfigurationError(
            "PHOTON_POLL_INTERVAL_SECONDS must be greater than zero"
        )

    pilot_flag = environ.get("MESSAGING_PILOT_ENABLED", "false").lower()
    if pilot_flag not in {"true", "false"}:
        raise ConfigurationError("MESSAGING_PILOT_ENABLED must be true or false")
    pilot_enabled = pilot_flag == "true"
    pilot_chat_ids: tuple[str, ...] = ()
    invalid_chat_ids = False
    if pilot_enabled:
        try:
            chat_ids = json.loads(environ.get("MESSAGING_PILOT_CHAT_IDS", "[]"))
            if (
                not isinstance(chat_ids, list)
                or len(chat_ids) > 1
                or any(
                    not isinstance(item, str) or not item.strip() for item in chat_ids
                )
            ):
                invalid_chat_ids = True
            else:
                pilot_chat_ids = tuple(chat_ids)
        except (ValueError, TypeError):
            invalid_chat_ids = True
    if invalid_chat_ids:
        raise ConfigurationError(
            "MESSAGING_PILOT_CHAT_IDS must be a JSON list of at most one space ID"
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
        pilot_enabled=pilot_enabled,
        pilot_chat_ids=pilot_chat_ids,
    )
