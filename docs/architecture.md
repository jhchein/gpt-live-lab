# Architecture

Use this guide to find the owner of a behavior before changing it. We separate session lifecycle, delegation execution and observation state. This keeps inspection views out of execution decisions and lets reasoning tests run without a Live connection.

This is a single-user, loopback-only demo. Setup, usage limits and privacy notes are in the [README](../README.md). The [glossary](../CONTEXT.md) defines the domain terms.

## Where to change behavior

Each area owns its implementation and module tests. The entry point, local gateway, token cache and clock context remain directly under `server/`; they do not need another layer.

| Change | Owner |
| --- | --- |
| Startup configuration and rate parsing | [`server/config/`](../server/config/). The [entry point](../server/index.ts) wires credentials, search and the gateway. |
| Local HTTP and WebSocket access | [`server/app.ts`](../server/app.ts). It enforces origins and the one-browser limit, then dispatches validated commands. |
| Voice-session lifecycle, delegation queue and delivery | [`server/live/`](../server/live/). It owns the Azure sideband connection, transcript context, append correlation and closure status. |
| Reasoning steps and tool continuation | [`server/reasoning/`](../server/reasoning/). It owns Responses streaming, source collection, sentence delivery and aggregate reasoning/search usage. |
| Web IQ requests and retry policy | [`server/search/`](../server/search/). It owns dispatch, the shared rate window, response limits and cancellation during retry waits. |
| Backend trace redaction | [`server/diagnostics/`](../server/diagnostics/). Session exports have a separate, stricter [browser policy](../src/inspection/diagnostics/export.ts). |
| Browser commands, server messages and configuration decoding | [`shared/protocol.ts`](../shared/protocol.ts). Types and runtime validation live together. |
| Cost estimates and source references | [`shared/pricing.ts`](../shared/pricing.ts) and [`shared/search.ts`](../shared/search.ts). These rules do not depend on React or network transports. |
| Browser connection and audio lifecycle | [`src/session/`](../src/session/). The hook coordinates the session; `BrowserAudio` owns microphone, WebRTC and playback resources. |
| Observation state and inspection views | [`src/inspection/`](../src/inspection/). View-specific models live beside their views; [`src/ui/`](../src/ui/) holds shared presentation helpers. |

The React [App](../src/App.tsx) composes the page. Inspection reads observed activity and never starts model work.

## Startup and delegation

Audio travels directly between the browser and Azure over WebRTC. The local WebSocket carries controls, transcripts, traces and usage. The backend's Azure sideband connection is a separate channel.

After Start, the browser acquires its microphone and gathers ICE candidates. Opening the local WebSocket sends `prepare`, which overlaps Azure authentication with ICE gathering. Once the offer is ready, `start` asks the backend to create the Azure session. The backend attaches its sideband connection before returning the SDP answer.

A browser connection owns at most one voice session. A new start opens a new connection. `LiveSession` owns this lifecycle and serializes delegations; `DelegationExecutor` receives transcript and delivery callbacks without owning the Live connection.

For each delegation, the executor waits briefly for in-flight transcripts and takes a context snapshot. It runs reasoning steps, executes requested searches and continues with their results. Completed sentences can reach GPT-Live before the model response finishes. Preliminary text stays buffered while a search-enabled step has no sources.

An append acknowledgement means Azure accepted a delivery chunk. It does not prove that the user heard it.

## Stop and failures

Stop releases microphone capture and local playback immediately. After session creation has been requested, the browser keeps WebRTC and the control socket available for graceful Azure closure.

The backend requests `session.close` and waits up to five seconds for `session.closed`. The browser allows seven seconds for backend confirmation. On a terminal state, it closes media and keeps the local socket for another 600 ms to receive trailing metrics. Cancelling startup after `start`, or closing without confirmation, leaves remote closure uncertain.

Failure handling follows the owner of the work:

- The gateway reports rejected commands as `browser.command.error`. Malformed backend messages fail the browser session instead of entering inspection state.
- A failed reasoning stream reports incomplete output if sentences were already delivered. It does not emit a completed answer.
- Search failures become explicit tool results so the model can explain the failure. The search adapter owns the single 503 retry, including `Retry-After`, cancellation and the remaining deadline.
- Only dispatched search attempts enter the estimate. Scheduling a retry is not another attempt. A failed attempt can still incur charges.

Cancellation stops local work and delivery. It does not confirm that a remote provider stopped computing.

## Keep these rules when changing code

We test through the existing module interfaces rather than adding parallel session managers or provider frameworks.

- Change browser commands and server-message validation together in the shared protocol. Unknown additive message fields remain compatible; known numeric fields must be valid. Missing usage and prices remain unknown, while explicit zero remains zero.
- Keep queue and connection decisions in `LiveSession`. A search setting change applies to the next delegation, not to a delegation already running.
- Keep execution independent of retained UI history. Observation state preserves current activity when old event details leave the bounded buffers.
- Keep credentials and opaque model state out of traces. Do not merge trace and export policies merely because both redact data. Review free text before sharing an export.

Run `npm test` and `npm run build` after changes. Test discovery includes nested server, shared and frontend tests. The [backend-session checks](../tests/backend-session.test.ts) exercise lifecycle, streaming, tool continuation and shutdown across modules using local mocks. [Protocol tests](../shared/protocol.test.ts) and the [gateway test](../server/app.test.ts) cover decoding without React, Azure credentials or paid calls.
