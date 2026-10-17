import sqlite3
from datetime import UTC, datetime, timedelta

from api.messaging.delivery_ledger import DeliveryLedger, OutboundReply
from api.messaging.messages import InboundMessage

NOW = datetime(2026, 10, 16, 12, 0, tzinfo=UTC)


def inbound(message_id: str = "pho_msg_1") -> InboundMessage:
    return InboundMessage(message_id, "pho_agent", "pho_space", "incoming private text")


def test_checkpoint_persists_across_instances(tmp_path) -> None:
    path = tmp_path / "nested" / "delivery.db"
    first = DeliveryLedger(path)

    assert first.checkpoint_or_initialize(NOW) == NOW
    assert (
        DeliveryLedger(path).checkpoint_or_initialize(NOW + timedelta(hours=1)) == NOW
    )

    with sqlite3.connect(path) as connection:
        assert connection.execute(
            "SELECT value FROM metadata WHERE key = 'poll_checkpoint'"
        ).fetchone() == (NOW.isoformat(),)


def test_duplicate_message_is_rejected_across_instances(tmp_path) -> None:
    path = tmp_path / "delivery.db"
    first = DeliveryLedger(path)
    second = DeliveryLedger(path)

    assert first.enqueue_reply(inbound(), "first reply", NOW)
    assert not second.enqueue_reply(inbound(), "different reply", NOW)
    assert [reply.text for reply in second.due_replies(NOW)] == ["first reply"]

    with sqlite3.connect(path) as connection:
        assert connection.execute(
            "SELECT count(*) FROM inbound_messages"
        ).fetchone() == (1,)
        assert connection.execute(
            "SELECT count(*) FROM outbound_replies"
        ).fetchone() == (1,)


def test_new_reply_is_due_and_rebuilds_routing_fields(tmp_path) -> None:
    ledger = DeliveryLedger(tmp_path / "delivery.db")
    ledger.enqueue_reply(inbound(), "outgoing text", NOW)

    assert ledger.due_replies(NOW - timedelta(microseconds=1)) == []
    assert ledger.due_replies(NOW) == [
        OutboundReply(
            message=InboundMessage("pho_msg_1", "pho_agent", "pho_space", ""),
            text="outgoing text",
            attempt_count=0,
        )
    ]


def test_mark_sent_removes_due_reply(tmp_path) -> None:
    ledger = DeliveryLedger(tmp_path / "delivery.db")
    ledger.enqueue_reply(inbound(), "outgoing text", NOW)
    sent_at = NOW + timedelta(seconds=1)

    ledger.mark_sent("pho_msg_1", sent_at)

    assert ledger.due_replies(sent_at) == []
    with sqlite3.connect(tmp_path / "delivery.db") as connection:
        assert connection.execute(
            "SELECT state, sent_at FROM outbound_replies WHERE message_id = ?",
            ("pho_msg_1",),
        ).fetchone() == ("sent", sent_at.isoformat())


def test_checkpoint_advances_and_persists(tmp_path) -> None:
    path = tmp_path / "delivery.db"
    ledger = DeliveryLedger(path)
    ledger.checkpoint_or_initialize(NOW)
    later = NOW + timedelta(minutes=2)

    ledger.advance_checkpoint(later)

    assert (
        DeliveryLedger(path).checkpoint_or_initialize(NOW + timedelta(hours=1)) == later
    )


def test_rendered_outgoing_text_is_stable_across_restarts(tmp_path) -> None:
    path = tmp_path / "delivery.db"
    first = DeliveryLedger(path)

    assert (
        first.bind_outgoing_text("outgoing-1", "Original status") == "Original status"
    )
    assert (
        DeliveryLedger(path).bind_outgoing_text("outgoing-1", "Changed status")
        == "Original status"
    )


def test_failures_retry_at_five_then_ten_seconds_and_third_is_terminal(
    tmp_path,
) -> None:
    path = tmp_path / "delivery.db"
    ledger = DeliveryLedger(path)
    ledger.enqueue_reply(inbound(), "outgoing text", NOW)
    private_error = RuntimeError("secret and message body must never be stored")

    assert ledger.mark_send_failed("pho_msg_1", NOW, private_error) == "pending"
    assert ledger.due_replies(NOW + timedelta(seconds=4)) == []
    assert [
        reply.attempt_count for reply in ledger.due_replies(NOW + timedelta(seconds=5))
    ] == [1]

    second_at = NOW + timedelta(seconds=5)
    assert ledger.mark_send_failed("pho_msg_1", second_at, private_error) == "pending"
    assert ledger.due_replies(second_at + timedelta(seconds=9)) == []
    assert [
        reply.attempt_count
        for reply in ledger.due_replies(second_at + timedelta(seconds=10))
    ] == [2]

    third_at = second_at + timedelta(seconds=10)
    assert ledger.mark_send_failed("pho_msg_1", third_at, private_error) == "failed"
    assert ledger.due_replies(third_at + timedelta(days=1)) == []
    with sqlite3.connect(path) as connection:
        assert connection.execute(
            "SELECT state, attempt_count, last_error FROM outbound_replies WHERE message_id = ?",
            ("pho_msg_1",),
        ).fetchone() == ("failed", 3, "RuntimeError")
