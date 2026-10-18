# In-app phone updates

A resident types **Status** inside WasteGrid and explicitly consents to an update
on the registered phone. The server snapshots the report's committed current
state and queues it in the existing durable messaging outbox. This flow uses the
already verified Photon iMessage connection; it does not provision SMS, invoke AI,
issue a link code, or require a phone-side linking command.

## Resident contract

Both endpoints require that report's bearer access token. They never accept a
recipient, phone number, chat identifier, or provider credentials from the client.

- `GET /reports/{report_id}/phone-updates` returns `enabled`, `phone_label`, and
  `latest_request` (nullable). This read creates no pilot, link, or message.
- `POST /reports/{report_id}/phone-updates` accepts
  `{ "command_id": "<UUID>", "message": "Status", "consent": true }`.
  Only case and outer whitespace are normalized; other commands return 422.
- The receipt contains `{id,status,message,created_at}`. `id` equals `command_id`.
  `message` is the frozen report status text, not a delivery claim. Status is one
  of `queued`, `sending`, `submitted`, `delivered`, `failed`, `uncertain`, or
  `cancelled`. `submitted` records provider acceptance/dispatch; only `delivered`
  means provider-confirmed delivery.

Persist the command UUID before POST. After a network error, keep it and retry
only that UUID to retrieve the existing receipt. GET can reconcile its matching
`latest_request.id`. Repeating a command never queues another message, including
after STOP, disabling the feature, later report changes, or an uncertain send.
A different command while that report has a pending or uncertain request returns
409; inspect the existing receipt rather than creating more requests.

Missing authentication returns 401; another report's token returns 404. Unsupported
input, false/missing consent, or extra fields return 422. Unavailable configuration
or an out-of-scope report returns 503; paused chat, identity/scope mismatch, or a
reused command UUID on another report returns 409; exhausted send budget returns
429. Reads remain available to inspect a resident's earlier receipt when disabled.

## Operator configuration

Retain the existing approved two-report pilot, project, sender, and single chat.
In addition to its current settings, configure:

- `MESSAGING_PILOT_PEER_ID`: the provider identity of the already confirmed phone
  owner in that exact direct chat, never an arbitrary client-supplied identity.
- `MESSAGING_PILOT_PHONE_LABEL`: exactly `Registered phone ending 1234`, replacing
  only the four digits. Configuration rejects an unmasked phone number or email.

Both fields default empty, so direct phone requests stay unavailable until the
operator completes this setup. A conflicting persisted chat identity is rejected;
configuration cannot silently adopt another peer or reset a pilot's counters.
No migration is required. Regenerate API artifacts with
`python -m scripts.export_contracts`.

Each app request authorizes only that status snapshot to the configured chat.
New report/chat records stay inactive for automatic notifications; a request does
not activate or reactivate an ongoing subscription. Previously authorized legacy
subscriptions retain their existing state. The existing pilot's 30 send-attempt
lifetime budget is unchanged. Queueing consumes no send attempt; the `/sending`
transition atomically charges it before provider submission. No image or text
model budget is used by this route.

Run only the reviewed bounded messaging poller with the same existing delivery
ledger and scope to dispatch the outbox and ingest phone-side controls. This route
does not need the follow-up model worker. The recipient's STOP pauses the chat,
cancels unsent work, and prevents new app requests from resuming it; START from the
phone resumes it. Keep unknown submissions in the ledger for reconciliation and
never blindly resend them. Stop/drain the existing runner before disabling the
API flag, retaining its private receipt ledger.


The Android report screen shows the snapshot immediately as a WasteGrid reply.
It checks that same receipt every three seconds while foregrounded, for up to
90 seconds, stopping on delivery/failure/cancellation or unmount. These checks
are authenticated reads and never create or resend a message. Provider acceptance
remains "submitted" until an actual delivered receipt exists. Manual refresh is
available after automatic checks end.
