from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: SecretStr
    reflection_api_key: SecretStr = Field(min_length=1)
    openrouter_api_key: SecretStr = Field(min_length=1)
    voyage_api_key: SecretStr = Field(min_length=1)

    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    voyage_base_url: str = "https://api.voyageai.com/v1"
    extraction_model: str = "openai/gpt-5.6-luna"
    extraction_provider: str = "openai"
    extraction_reasoning_effort: Literal["none", "low", "medium", "high", "xhigh"] = "medium"
    extraction_native_schema: bool = True
    resolution_model: str = "openai/gpt-5.6-luna"
    resolution_provider: str = "openai"
    resolution_reasoning_effort: Literal["none", "low", "medium", "high", "xhigh"] = "medium"
    resolution_native_schema: bool = True
    embedding_model: str = "voyage-4-large"
    embedding_dimensions: int = 1024

    database_pool_min_size: int = 1
    database_pool_max_size: int = 8
    worker_poll_seconds: float = 1.0
    worker_max_attempts: int = 3
    worker_retry_backoff_seconds: float = 2.0
    worker_lock_id: int = 7_320_260_818_001
    migration_lock_id: int = 7_320_260_818_002
    request_timeout_seconds: float = 120.0
    model_call_timeout_seconds: float = 180.0
    migrations_dir: Path = Path("migrations")
    log_level: str = "INFO"

    @field_validator("openrouter_base_url", "voyage_base_url")
    @classmethod
    def strip_url_suffix(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator("database_pool_max_size")
    @classmethod
    def require_worker_and_request_connections(cls, value: int) -> int:
        if value < 2:
            raise ValueError("database_pool_max_size must be at least 2")
        return value

    @field_validator("embedding_dimensions")
    @classmethod
    def require_voyage_dimensions(cls, value: int) -> int:
        if value != 1024:
            raise ValueError("voyage-4-large embeddings must use 1024 dimensions")
        return value

    @field_validator("worker_max_attempts")
    @classmethod
    def require_positive_attempts(cls, value: int) -> int:
        if value < 1:
            raise ValueError("worker_max_attempts must be at least 1")
        return value

    @field_validator("worker_retry_backoff_seconds")
    @classmethod
    def require_nonnegative_backoff(cls, value: float) -> float:
        if value < 0:
            raise ValueError("worker_retry_backoff_seconds cannot be negative")
        return value

    @model_validator(mode="after")
    def require_compatible_model_routes(self) -> "Settings":
        profiles = (
            (
                "extraction",
                self.extraction_model,
                self.extraction_provider,
                self.extraction_native_schema,
            ),
            (
                "resolution",
                self.resolution_model,
                self.resolution_provider,
                self.resolution_native_schema,
            ),
        )
        for name, model, provider, native_schema in profiles:
            if model.startswith("deepseek/") and provider in {"azure", "openai"}:
                raise ValueError(
                    f"{name}_model={model!r} is incompatible with {name}_provider={provider!r}"
                )
            if provider == "deepseek" and not model.startswith("deepseek/"):
                raise ValueError(
                    f"{name}_provider='deepseek' requires a DeepSeek model, got {model!r}"
                )
            if provider == "deepseek" and native_schema:
                raise ValueError(
                    f"{name}_native_schema requires a provider with structured-output support"
                )
        return self
