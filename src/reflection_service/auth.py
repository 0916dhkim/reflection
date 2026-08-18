import secrets

from fastapi import Header, HTTPException, status


class APIKeyAuth:
    def __init__(self, expected_key: str) -> None:
        self._expected_key = expected_key

    async def __call__(self, x_api_key: str | None = Header(default=None)) -> None:
        supplied = x_api_key or ""
        if not secrets.compare_digest(supplied.encode(), self._expected_key.encode()):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid API key",
            )
