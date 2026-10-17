# Photon backend adapter design

## Goal

Replace Photon’s local echo and SQLite delivery ownership with a fail-fast adapter
to the proposed WasteGrid backend messaging contract. The adapter remains
mock-tested until Person 2's backend pull request is merged and deployed.

## Scope

- Require a backend base URL and messaging API key before Photon polling starts.
- Resolve a Photon sender to a backend conversation and enqueue each inbound
  message by its stable Photon message ID.
- Claim backend-owned outgoing messages, send them through Photon, and
  acknowledge the exact sent text and provider message ID.
- Use short bounded HTTP timeouts and avoid logging credentials, request bodies,
  response bodies, or signed URLs.
- Preserve the existing Photon polling gateway as the transport boundary.

## Non-goals

- Do not implement backend persistence, reasoning, report creation, or mobile
  photo upload.
- Do not keep a local reply or retry ledger in backend mode.
- Do not provide a local echo fallback when backend settings are absent.
- Do not call a real backend or require Person 2's unmerged branch in tests.

## Architecture

`WasteGridBackendClient` is a small synchronous HTTP client behind a protocol.
It owns only the backend messaging endpoints and raises a sanitized client error
for unavailable or invalid backend responses. Its configuration is loaded with
the existing Photon settings and contains:

- `WASTEGRID_BACKEND_URL`, an absolute HTTP(S) URL without query, fragment, or
  credentials.
- `WASTEGRID_MESSAGING_API_KEY`, a non-empty bearer credential.
- `PHOTON_AGENT_SENDER_ID`, the stable Photon sender used for every claimed
  outgoing iMessage. The backend stores the conversation `space_id`, but does
  not store this transport-specific sender identity.
- An optional positive timeout with a conservative default.

The production runner uses a backend-aware coordinator instead of
`DeliveryCoordinator` and `SmokeTestReplyPolicy`. The coordinator first drains
already-claimed backend messages, then for each fresh Photon message resolves
the sender as an iMessage conversation and submits the stable Photon message ID
and text as one follow-up. It claims again after inbound submission so a
fast worker response can be delivered in the same poll cycle.

## Backend contract

The implementation targets Person 2's documented proposed-v0.2 endpoints:

1. `POST /internal/conversations/resolve` with `{channel, external_id}`.
2. `POST /internal/conversations/{id}/followup` with `{message_id, text}`.
3. `POST /internal/outgoing-messages/claim` with `{limit}`.
4. `POST /internal/outgoing-messages/{id}/delivered` with
   `{lease_id, provider_message_id, sent_text}`.

All requests carry `Authorization: Bearer <messaging key>`. An unknown or
unlinked sender is skipped with a message-ID-only warning. Other backend
failures leave the inbound item unacknowledged by the backend so its idempotency
rules remain authoritative on a later poll.

Only claimed outgoing messages whose conversation channel is `imessage` are
eligible for sending. The conversation external ID becomes the Photon `spaceId`;
the required configured sender ID becomes Photon `senderId`. The adapter
acknowledges only after Photon succeeds. If Photon sending fails, it does not
acknowledge; the backend lease expiry controls the retry.

## Error handling

- Missing or invalid backend configuration, including `PHOTON_AGENT_SENDER_ID`,
  fails startup before any Photon read.
- Non-2xx responses and malformed JSON raise a generic backend client error
  that includes status or operation context but never remote body text.
- A 404 conversation resolution is treated as a non-fatal unlinked sender.
- A message is never locally echoed, locally persisted, or acknowledged as
  delivered before Photon confirms its send operation.

## Tests

Tests use a recording fake HTTP transport and Photon sender double. They prove:

- backend configuration is mandatory and valid;
- the configured Photon sender ID is used for claimed outbound messages after a
  process restart;
- each backend request has the bearer header and expected payload;
- inbound messages retain their Photon IDs for backend idempotency;
- unlinked senders do not enqueue follow-ups;
- only matching iMessage outgoing records are delivered;
- a failed Photon send produces no delivery acknowledgement;
- acknowledgements contain the exact delivered text and Photon provider ID.

## Acceptance criteria

- No production reply path uses `SmokeTestReplyPolicy` or `DeliveryLedger` in
  backend mode.
- Missing backend settings prevent polling from starting.
- The adapter speaks only the four documented internal endpoints.
- Unit tests exercise the complete inbound-to-outbound adapter sequence without
  a live backend or Photon account.
