import secrets

import pytest
from fastapi import HTTPException

from reflection_service.auth import APIKeyAuth


@pytest.mark.asyncio
async def test_api_key_auth_uses_constant_time_comparison(monkeypatch: pytest.MonkeyPatch) -> None:
    compared: list[tuple[bytes, bytes]] = []

    def compare(left: bytes, right: bytes) -> bool:
        compared.append((left, right))
        return left == right

    monkeypatch.setattr(secrets, "compare_digest", compare)
    auth = APIKeyAuth("expected")

    await auth("expected")

    assert compared == [(b"expected", b"expected")]


@pytest.mark.asyncio
async def test_api_key_auth_rejects_missing_key() -> None:
    auth = APIKeyAuth("expected")

    with pytest.raises(HTTPException) as raised:
        await auth(None)

    assert raised.value.status_code == 401
