# Photon Beta iMessage Agent Design

## Context

WasteGrid is a Chalk Python project with no existing messaging implementation. The active Photon project is a Beta project because its identifier begins with `pho_prj_` and it is managed through the Beta dashboard. The stable Spectrum CLI and `spectrum-ts` SDK are intentionally out of scope.

The user has completed Photon iMessage onboarding and has created a local project API key in an ignored `.env` file in the primary checkout. The isolated worktree intentionally does not contain that secret.

## Chosen approach

Add a small Python agent under `api/messaging/` using Photon’s official `photonhq-api` client. The process polls only iMessage messages received after startup, sends one exact echo reply for each plain-text inbound message, and uses a deterministic idempotency key derived from the inbound Photon message ID.

This keeps the first vertical slice inside the future FastAPI service. It does not create a separate TypeScript service or combine the project with the incompatible Spectrum runtime.

## Public interface

`PhotonConfig` is an immutable value with `project_id`, `api_key`, and `poll_interval_seconds` fields. `load_photon_config(environ)` returns `PhotonConfig` or raises `ConfigurationError` when required variables are missing.

`InboundMessage` is an immutable value with `id`, `agent_sender_id`, `space_id`, and `text` fields. `agent_sender_id` comes from the inbound Photon message's `receivedBy.id`, which identifies the managed Photon line. `extract_inbound_text(message)` returns `InboundMessage | None`, returning `None` for non-iMessage, non-received, non-text, blank, or unaddressed messages.

`PhotonGateway` has `list_new_messages(since)` and `send_reply(message, text)`. `EchoAgent.process(messages)` returns the IDs of messages for which it requested a reply. It must never send more than one reply for the same ID within a process lifetime.

## Data flow

1. Load `PHOTON_PROJECT_ID` and `PHOTON_API_KEY` from the environment.
2. Record the UTC startup timestamp.
3. List messages with Photon’s `platform=imessage`, `direction=received`, and `createdSince` filters.
4. Extract each valid plain-text message.
5. Send `Photon Spectrum is connected. You said: <message>` as a new message in the same space from the `receivedBy` agent identity, using the incoming message ID as the idempotency key input. Shared iMessage spaces do not support threaded replies, so the request must not set `parentMessageId`.
6. Log polling failures without logging the API key or full phone number.

## Error handling

Configuration errors stop startup with clear messages. Photon API failures are logged and leave an inbound message eligible for retry on the next polling iteration. Invalid and non-text payloads are skipped.

## Non-goals

This slice does not link conversations to WasteGrid reports, call Chalk, persist message state across process restarts, expose a public webhook, or implement the organizer dashboard. Those require Person 2’s backend contracts and Person 3’s follow-up handler.

## Validation

Unit tests cover configuration, event filtering, reply content, idempotency, and gateway request construction without accessing Photon. A separate live smoke check lists project messages with the user’s local key. The user then sends a fresh iMessage after the agent starts and verifies the exact reply.
