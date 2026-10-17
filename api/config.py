"""Backend-only configuration. Missing cloud configuration fails closed at use."""

from pydantic import SecretStr
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
