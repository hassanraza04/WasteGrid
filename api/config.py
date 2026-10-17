"""Backend-only configuration. Missing cloud configuration fails closed at use."""

from typing import Literal
from uuid import UUID

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
    # Explicit, bounded canary. Empty allowlists never mean unrestricted access.
    messaging_pilot_enabled: bool = False
    messaging_pilot_id: UUID | None = None
    messaging_pilot_report_ids: list[UUID] = Field(default_factory=list, max_length=2)
    messaging_pilot_chat_ids: list[str] = Field(default_factory=list, max_length=1)
    messaging_imessage_recipient: str = ""
    photon_project_id: str = ""
    photon_agent_sender_id: str = ""
    organizer_routing_enabled: bool = False
    routing_osrm_base_url: str = ""
    routing_provider_timeout_seconds: float = Field(default=10, gt=0, le=30)
    routing_service_minutes: int = Field(default=5, gt=0, le=60)
    routing_location_max_age_seconds: int = Field(default=120, ge=10, le=3600)
    routing_preview_max_age_seconds: int = Field(default=120, ge=10, le=3600)
    routing_max_displacement_meters: float = Field(default=100, gt=0, le=1000)
    routing_improvement_budget: int = Field(default=10000, ge=0, le=100000)
    routing_solver_timeout_seconds: float = Field(default=5, gt=0, le=30)

    routing_wait_weight: float = Field(default=1, gt=0, le=100, allow_inf_nan=False)
    routing_finish_weight: float = Field(default=1, gt=0, le=100, allow_inf_nan=False)
    routing_travel_weight: float = Field(
        default=0.25, gt=0, le=100, allow_inf_nan=False
    )
