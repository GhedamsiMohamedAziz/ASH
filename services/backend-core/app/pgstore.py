"""Postgres persistence for conversations + messages (AX-012, §16.1).

Selected at startup when DATABASE_URL is set. Writes to the `conversations` and
`messages` tables from db/migrations/0001_init.sql. Events/WS stay in-memory
(transient); this only durably persists the conversation record and each message.
"""

from __future__ import annotations

import json

import asyncpg

from .models import Conversation, Message


class PgStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=5)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()

    async def ensure_dev_user(self, user_id: str, org_id: str = "org_dev") -> None:
        """Dev convenience: FK targets must exist. Seed org+user idempotently."""
        async with self._pool.acquire() as con:
            await con.execute(
                "INSERT INTO orgs(id, name) VALUES($1,$1) ON CONFLICT (id) DO NOTHING", org_id
            )
            await con.execute(
                """INSERT INTO users(id, org_id, email, role)
                   VALUES($1,$2,$3,'member') ON CONFLICT (id) DO NOTHING""",
                user_id, org_id, f"{user_id}@dev.local",
            )

    async def persist_conversation(self, conv: Conversation) -> None:
        async with self._pool.acquire() as con:
            await con.execute(
                """INSERT INTO conversations(id, user_id, channel, title, status)
                   VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING""",
                conv.id, conv.user_id, conv.channel.value, conv.title, conv.status,
            )

    async def persist_message(self, msg: Message) -> None:
        async with self._pool.acquire() as con:
            await con.execute(
                """INSERT INTO messages(id, conversation_id, role, content)
                   VALUES($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO NOTHING""",
                msg.id, msg.conversation_id, msg.role, json.dumps(msg.content),
            )

    async def fetch_messages(self, conversation_id: str) -> list[dict]:
        async with self._pool.acquire() as con:
            rows = await con.fetch(
                "SELECT id, conversation_id, role, content, created_at "
                "FROM messages WHERE conversation_id=$1 ORDER BY created_at",
                conversation_id,
            )
        return [dict(r) for r in rows]
