# WasteGrid

## Photon iMessage smoke agent

The first messaging slice uses the Photon Beta API to reply to fresh iMessages.
It is intentionally limited to a safe echo while the shared report and follow-up
contracts are still being built.

1. Create a local `.env` from `.env.example`.
2. Set `PHOTON_PROJECT_ID` and `PHOTON_API_KEY` with the values from Photon.
3. Start the agent:

   ```bash
   uv run --env-file .env python -m api.messaging.run_imessage_agent
   ```

4. Send a new iMessage to the Photon line after the process logs that it is polling.

The expected reply is:

```text
Photon Spectrum is connected. You said: <your message>
```

The process reads only fresh iMessages received after it starts. It ignores older
messages, non-iMessage events, blank messages, and duplicate message IDs within
one process lifetime. `.env` is ignored by Git and must never be committed.
