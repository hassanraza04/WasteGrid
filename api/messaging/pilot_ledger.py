"""Crash-safe polling windows and provider receipts for one pilot poller."""

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from api.messaging.delivery_ledger import DeliveryLedger, _utc_iso


@dataclass(frozen=True)
class ScanWindow:
    since: datetime
    before: datetime
    page_token: str | None
    reconciliation: bool


@dataclass(frozen=True)
class ProviderReceipt:
    message_id: str
    lease_id: str
    provider_message_id: str
    provider_status: str
    sent_text: str
    acknowledged: bool
    latest_status: str
    checked_at: datetime | None


class PilotLedger(DeliveryLedger):
    """A receipt is saved before acknowledging any provider submission."""

    def __init__(self, path: Path):
        super().__init__(path)
        with self._transaction() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS pilot_provider_receipts (
                message_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
                provider_message_id TEXT NOT NULL, provider_status TEXT NOT NULL,
                sent_text TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
                latest_status TEXT NOT NULL, checked_at TEXT
            )""")

    @staticmethod
    def _value(db, key: str) -> str | None:
        row = db.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    @staticmethod
    def _put(db, key: str, value: str) -> None:
        db.execute(
            "INSERT INTO metadata(key,value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def bind_identity(self, project_id: str, sender_id: str) -> None:
        """Never reuse provider receipts/checkpoints for a different integration."""
        identity = json.dumps([project_id, sender_id])
        with self._transaction() as db:
            previous = self._value(db, "pilot_identity")
            if previous is not None and previous != identity:
                raise ValueError("Pilot state belongs to a different project or sender")
            self._put(db, "pilot_identity", identity)

    def scan_window(self, now: datetime) -> ScanWindow:
        timestamp = _utc_iso(now)
        with self._transaction() as db:
            saved = self._value(db, "pilot_scan_window")
            if saved:
                value = json.loads(saved)
                return ScanWindow(
                    datetime.fromisoformat(value["since"]),
                    datetime.fromisoformat(value["before"]),
                    value["page_token"],
                    value["reconciliation"],
                )
            activation = self._value(db, "pilot_activation") or timestamp
            self._put(db, "pilot_activation", activation)
            checkpoint = self._value(db, "pilot_checkpoint") or activation
            last_full = self._value(db, "pilot_last_reconciliation") or activation
            reconciliation = now - datetime.fromisoformat(last_full) >= timedelta(
                minutes=15
            )

            since = (
                datetime.fromisoformat(activation)
                if reconciliation
                else max(
                    datetime.fromisoformat(activation),
                    datetime.fromisoformat(checkpoint) - timedelta(minutes=5),
                )
            )
            window = ScanWindow(since, now, None, reconciliation)
            self._put(
                db,
                "pilot_scan_window",
                json.dumps(
                    {
                        "since": _utc_iso(since),
                        "before": timestamp,
                        "page_token": None,
                        "reconciliation": reconciliation,
                    }
                ),
            )
            return window

    def page_processed(self, window: ScanWindow, next_token: str | None) -> None:
        with self._transaction() as db:
            if next_token is not None:
                self._put(
                    db,
                    "pilot_scan_window",
                    json.dumps(
                        {
                            "since": _utc_iso(window.since),
                            "before": _utc_iso(window.before),
                            "page_token": next_token,
                            "reconciliation": window.reconciliation,
                        }
                    ),
                )
            else:
                self._put(db, "pilot_checkpoint", _utc_iso(window.before))
                if window.reconciliation:
                    self._put(db, "pilot_last_reconciliation", _utc_iso(window.before))
                db.execute("DELETE FROM metadata WHERE key='pilot_scan_window'")

    def reset_page_token(self, window: ScanWindow) -> None:
        """Restart an expired provider cursor without changing the fixed window."""
        with self._transaction() as db:
            self._put(
                db,
                "pilot_scan_window",
                json.dumps(
                    {
                        "since": _utc_iso(window.since),
                        "before": _utc_iso(window.before),
                        "page_token": None,
                        "reconciliation": window.reconciliation,
                    }
                ),
            )

    def record_receipt(
        self,
        message_id: str,
        lease_id: str,
        provider_message_id: str,
        provider_status: str,
        sent_text: str,
    ) -> None:
        values = (message_id, lease_id, provider_message_id, provider_status, sent_text)
        with self._transaction() as db:
            db.execute(
                "INSERT OR IGNORE INTO pilot_provider_receipts "
                "(message_id,lease_id,provider_message_id,provider_status,"
                "sent_text,latest_status) "
                "VALUES (?,?,?,?,?,?)",
                (*values, provider_status),
            )
            actual = db.execute(
                "SELECT message_id,lease_id,provider_message_id,provider_status,sent_text "
                "FROM pilot_provider_receipts WHERE message_id=?",
                (message_id,),
            ).fetchone()
            if actual != values:
                raise ValueError("Provider receipt changed for an outgoing message")

    def receipts(self, *, unacknowledged: bool = False) -> list[ProviderReceipt]:
        with self._transaction() as db:
            rows = db.execute(
                "SELECT message_id,lease_id,provider_message_id,provider_status,"
                "sent_text,acknowledged,latest_status,checked_at "
                "FROM pilot_provider_receipts"
                + (" WHERE acknowledged=0" if unacknowledged else "")
                + " ORDER BY rowid"
            ).fetchall()
        return [
            ProviderReceipt(
                *row[:5],
                bool(row[5]),
                row[6],
                datetime.fromisoformat(row[7]) if row[7] else None,
            )
            for row in rows
        ]

    def acknowledge_receipt(self, message_id: str) -> None:
        with self._transaction() as db:
            db.execute(
                "UPDATE pilot_provider_receipts SET acknowledged=1 WHERE message_id=?",
                (message_id,),
            )

    def checked_receipt(self, message_id: str, status: str, now: datetime) -> None:
        with self._transaction() as db:
            db.execute(
                "UPDATE pilot_provider_receipts SET latest_status=?,checked_at=? "
                "WHERE message_id=?",
                (status, _utc_iso(now), message_id),
            )
