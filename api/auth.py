"""
Simple authentication for the API.

Supports:
- API key authentication (X-API-Key header)
- Optional JWT authentication (for future use)

For development, auth can be disabled via DISABLE_AUTH=1 env var.
"""

import os
from functools import wraps
from typing import Optional

from fastapi import HTTPException, Header, Depends
from fastapi.security import APIKeyHeader

# Configuration
API_KEY = os.environ.get("API_KEY", "dev-api-key")
DISABLE_AUTH = os.environ.get("DISABLE_AUTH", "1") == "1"

# API Key header scheme
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def verify_api_key(api_key: Optional[str] = Depends(api_key_header)) -> str:
    """Verify the API key from request header.

    Returns the user identifier (for now, just 'api-user').
    """
    if DISABLE_AUTH:
        return "anonymous"

    if api_key is None:
        raise HTTPException(
            status_code=401,
            detail="Missing API key. Include X-API-Key header."
        )

    if api_key != API_KEY:
        raise HTTPException(
            status_code=403,
            detail="Invalid API key"
        )

    return "api-user"


async def optional_auth(api_key: Optional[str] = Depends(api_key_header)) -> Optional[str]:
    """Optional authentication - returns user if authenticated, None otherwise."""
    if DISABLE_AUTH:
        return "anonymous"

    if api_key is None:
        return None

    if api_key != API_KEY:
        return None

    return "api-user"


def require_auth(func):
    """Decorator to require authentication for an endpoint."""
    @wraps(func)
    async def wrapper(*args, user: str = Depends(verify_api_key), **kwargs):
        return await func(*args, user=user, **kwargs)
    return wrapper
