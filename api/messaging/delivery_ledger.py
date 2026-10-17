"""Local SQLite checkpoint and reply spool for Photon delivery."""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from api.messaging.messages import InboundMessage


@dataclass(frozen=True)
class OutboundReply:
    message: InboundMessage
    text: str
    attempt_count: int


def _utc_iso(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("A timezone-aware datetime is required")
    return value.astimezone(UTC).isoformat()


class DeliveryLedger:
    """Persist transport state across restarts of a single Photon poller."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._transaction() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS inbound_messages (
                    message_id TEXT PRIMARY KEY,
                    received_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS outbound_replies (
                    message_id TEXT PRIMARY KEY,
                    agent_sender_id TEXT NOT NULL,
                    space_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    state TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL,
                    next_attempt_at TEXT,
                    last_error TEXT,
                    created_at TEXT NOT NULL,
                    sent_at TEXT
                );
                CREATE TABLE IF NOT EXISTS outgoing_texts (
                    message_id TEXT PRIMARY KEY,
                    text TEXT NOT NULL
                );
                """)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def checkpoint_or_initialize(self, now: datetime) -> datetime:
        timestamp = _utc_iso(now)
        with self._transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO metadata (key, value) VALUES ('poll_checkpoint', ?)",
                (timestamp,),
            )
            row = connection.execute(
                "SELECT value FROM metadata WHERE key = 'poll_checkpoint'"
            ).fetchone()
        assert row is not None
        return datetime.fromisoformat(row[0])

    def advance_checkpoint(self, checkpoint: datetime) -> None:
        with self._transaction() as connection:
            connection.execute(
                "INSERT INTO metadata (key, value) VALUES ('poll_checkpoint', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (_utc_iso(checkpoint),),
            )

    def bind_outgoing_text(self, message_id: str, text: str) -> str:
        """Persist the first rendered text for one backend-owned outgoing ID."""
        with self._transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO outgoing_texts (message_id, text) VALUES (?, ?)",
                (message_id, text),
            )
            row = connection.execute(
                "SELECT text FROM outgoing_texts WHERE message_id = ?", (message_id,)
            ).fetchone()
        assert row is not None
        return row[0]

    def enqueue_reply(self, message: InboundMessage, text: str, now: datetime) -> bool:
        timestamp = _utc_iso(now)
        with self._transaction() as connection:
            inserted = connection.execute(
                "INSERT OR IGNORE INTO inbound_messages (message_id, received_at) VALUES (?, ?)",
                (message.id, timestamp),
            ).rowcount
            if inserted:
                connection.execute(
                    "INSERT INTO outbound_replies "
                    "(message_id, agent_sender_id, space_id, text, state, attempt_count, "
                    "next_attempt_at, last_error, created_at, sent_at) "
                    "VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?, NULL)",
                    (
                        message.id,
                        message.agent_sender_id,
                        message.space_id,
                        text,
                        timestamp,
                        timestamp,
                    ),
                )
        return bool(inserted)

    def due_replies(self, now: datetime) -> list[OutboundReply]:
        with self._transaction() as connection:
            rows = connection.execute(
                "SELECT message_id, agent_sender_id, space_id, text, attempt_count "
                "FROM outbound_replies WHERE state = 'pending' AND next_attempt_at <= ? "
                "ORDER BY next_attempt_at, created_at, message_id",
                (_utc_iso(now),),
            ).fetchall()
        return [
            OutboundReply(InboundMessage(row[0], row[1], row[2], ""), row[3], row[4])
            for row in rows
        ]

    def mark_sent(self, message_id: str, now: datetime) -> None:
        with self._transaction() as connection:
            connection.execute(
                "UPDATE outbound_replies SET state = 'sent', sent_at = ?, next_attempt_at = NULL "
                "WHERE message_id = ? AND state = 'pending'",
                (_utc_iso(now), message_id),
            )

    def mark_send_failed(self, message_id: str, now: datetime, error: Exception) -> str:
        timestamp = _utc_iso(now)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT attempt_count FROM outbound_replies "
                "WHERE message_id = ? AND state = 'pending'",
                (message_id,),
            ).fetchone()
            if row is None:
                raise ValueError("No pending reply for message ID")
            attempt_count = row[0] + 1
            state = "failed" if attempt_count >= 3 else "pending"
            next_attempt_at = (
                None
                if state == "failed"
                else _utc_iso(
                    datetime.fromisoformat(timestamp)
                    + timedelta(seconds=5 * attempt_count)
                )
            )
            connection.execute(
                "UPDATE outbound_replies SET state = ?, attempt_count = ?, "
                "next_attempt_at = ?, last_error = ? WHERE message_id = ?",
                (
                    state,
                    attempt_count,
                    next_attempt_at,
                    type(error).__name__,
                    message_id,
                ),
            )
        return state
