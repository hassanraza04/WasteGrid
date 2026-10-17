"""Backend-only configuration. Missing cloud configuration fails closed at use."""

from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: SecretStr | None = None
    supabase_url: str = ""
    supabase_secret_key: SecretStr | None = None
    supabase_photo_bucket: str = "report-photos"
    messaging_api_key: SecretStr | None = None
    agent_api_key: SecretStr | None = None
    person3_base_url: str = ""
    person3_api_key: SecretStr | None = None
    integration_factory: str = ""
    cors_origins: list[str] = []
    photo_max_bytes: int = 8 * 1024 * 1024
    photo_url_ttl_seconds: int = 300

    chalk_router_api_key: SecretStr | None = None
    chalk_env_id: str = ""
    chalk_model: str = "groq/qwen/qwen3.8-27b"
    chalk_router_base_url: str = "https://api.chalk.ai/v1/router"
    chalk_reasoning_effort: Literal["none", "low", "medium", "high", "xhigh"] | None = (
        None
    )
    assessment_timeout_seconds: float = Field(default=30, gt=0, le=120)
    duplicate_radius_meters: float = Field(default=10, ge=0, le=100)
