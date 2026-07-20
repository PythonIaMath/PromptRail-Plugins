from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timezone

from fastapi import HTTPException, status


TOKEN_ENV = "PROMPTRAIL_ROUTER_TOKEN"
MONGODB_URI_ENV = "MONGODB_URI"
MONGODB_DATABASE_ENV = "LEROUTER_MODEL_PROFILE_DB"
API_KEY_COLLECTION_ENV = "LEROUTER_API_KEY_COLLECTION"
PLUGIN_ACCESS_COLLECTION_ENV = "LEROUTER_PLUGIN_ACCESS_COLLECTION"
ACTIVE_SUBSCRIPTION_STATUSES = {"active", "trialing"}
_mongo_client = None


def _api_key_collection():
    uri = os.environ.get(MONGODB_URI_ENV, "").strip()
    if not uri:
        return None

    from pymongo import MongoClient

    global _mongo_client
    if _mongo_client is None:
        _mongo_client = MongoClient(
            uri,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
            socketTimeoutMS=5000,
        )
    database = os.environ.get(MONGODB_DATABASE_ENV, "lerouter")
    collection = os.environ.get(API_KEY_COLLECTION_ENV, "api_keys")
    return _mongo_client[database][collection]


def _plugin_access_allowed(database, user_id: str | None) -> bool:
    if not user_id:
        return False

    access = database[os.environ.get(PLUGIN_ACCESS_COLLECTION_ENV, "plugin_access")]
    subscription = access.find_one(
        {"id": f"plugin-subscription:{user_id}", "type": "subscription"},
        {"_id": 0, "status": 1},
    )
    return str((subscription or {}).get("status", "")).lower() in ACTIVE_SUBSCRIPTION_STATUSES


def _valid_account_token(token: str) -> bool:
    collection = _api_key_collection()
    if collection is None:
        return False

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    try:
        row = collection.find_one(
            {"keyHash": token_hash, "revokedAt": None},
            {"_id": 0, "id": 1, "userId": 1},
        )
        if not row:
            return False
        if not _plugin_access_allowed(collection.database, row.get("userId")):
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail="PromptRail Plugins requires an active subscription",
            )
        now = datetime.now(timezone.utc)
        collection.update_one(
            {"id": row.get("id")},
            {"$set": {"lastUsedAt": now, "updatedAt": now}},
        )
        return True
    except HTTPException:
        raise
    except Exception as error:
        global _mongo_client
        _mongo_client = None
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PromptRail token database is unavailable",
        ) from error


def require_router_auth(authorization: str | None) -> None:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token or len(token) > 4096:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid PromptRail router token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    expected = os.environ.get(TOKEN_ENV, "")
    if expected and hmac.compare_digest(token, expected):
        return
    if _valid_account_token(token):
        return
    if not expected and not os.environ.get(MONGODB_URI_ENV, "").strip():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PromptRail router authentication is not configured",
        )
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid PromptRail router token",
        headers={"WWW-Authenticate": "Bearer"},
    )
