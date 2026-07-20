from __future__ import annotations

import hashlib
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

from fastapi import HTTPException


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "internal_service_auth",
    ROOT / "internal_service_auth.py",
)
auth = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(auth)


class FakeAccessCollection:
    def __init__(self, status: str | None) -> None:
        self.status = status

    def find_one(self, query, projection):
        if query == {"id": "plugin-subscription:user-1", "type": "subscription"}:
            return {"status": self.status} if self.status else None
        return None


class FakeDatabase:
    def __init__(self, status: str | None) -> None:
        self.status = status

    def __getitem__(self, name: str):
        if name != "plugin_access":
            raise AssertionError(f"unexpected collection: {name}")
        return FakeAccessCollection(self.status)


class FakeApiKeyCollection:
    def __init__(self, token: str, status: str | None = "active") -> None:
        self.database = FakeDatabase(status)
        self.token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        self.updated = None

    def find_one(self, query, projection):
        if query == {"keyHash": self.token_hash, "revokedAt": None}:
            return {"id": "key-1", "userId": "user-1"}
        return None

    def update_one(self, query, update):
        self.updated = (query, update)


class InternalServiceAuthTest(unittest.TestCase):
    def test_accepts_private_service_token(self) -> None:
        with patch.dict(auth.os.environ, {auth.TOKEN_ENV: "service-token"}, clear=True):
            with patch.object(auth, "_valid_account_token", return_value=False):
                auth.require_router_auth("Bearer service-token")

    def test_accepts_generated_account_token_with_active_subscription(self) -> None:
        token = "lr_live_generated_customer_token"
        collection = FakeApiKeyCollection(token)
        with patch.dict(auth.os.environ, {auth.TOKEN_ENV: "service-token"}, clear=True):
            with patch.object(auth, "_api_key_collection", return_value=collection):
                auth.require_router_auth(f"Bearer {token}")
        self.assertEqual(collection.updated[0], {"id": "key-1"})

    def test_rejects_generated_account_token_without_active_subscription(self) -> None:
        token = "lr_live_generated_customer_token"
        collection = FakeApiKeyCollection(token, status="past_due")
        with patch.dict(auth.os.environ, {auth.TOKEN_ENV: "service-token"}, clear=True):
            with patch.object(auth, "_api_key_collection", return_value=collection):
                with self.assertRaises(HTTPException) as captured:
                    auth.require_router_auth(f"Bearer {token}")
        self.assertEqual(captured.exception.status_code, 402)

    def test_rejects_unknown_token(self) -> None:
        collection = FakeApiKeyCollection("lr_live_known")
        with patch.dict(auth.os.environ, {auth.TOKEN_ENV: "service-token"}, clear=True):
            with patch.object(auth, "_api_key_collection", return_value=collection):
                with self.assertRaises(HTTPException) as captured:
                    auth.require_router_auth("Bearer lr_live_unknown")
        self.assertEqual(captured.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
