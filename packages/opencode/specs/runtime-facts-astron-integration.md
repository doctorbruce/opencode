# Runtime Facts Astron Integration

## Goal

Astron should treat opencode as the source of truth for runtime facts that opencode already owns, instead of reconstructing them from UI timing, tool metadata, or secondary lookups.

This document describes the two current facts exposed by this fork:

- parent message subtask part to child session relation
- durable event sequence metadata on the legacy `/event` SSE stream

## Parent Subtask To Child Session

When a Task-spawned subagent creates or reuses a child session, opencode stores the child session id on the parent user message's subtask part.

Example parent message part:

```json
{
  "id": "prt_...",
  "type": "subtask",
  "sessionID": "ses_parent",
  "childSessionID": "ses_child",
  "message": "Review the implementation",
  "agent": "reviewer"
}
```

Field meaning:

- `sessionID` remains the parent session that owns the message and part.
- `childSessionID` is the spawned or reused child session for that subtask.
- `childSessionID` is optional because older stored messages do not have it, and non-Task subtask-like data may not create a child session.

Recommended Astron behavior:

- Prefer `part.childSessionID` when building the relation between a parent group agent turn and a child session.
- Keep the existing tool metadata or children API fallback only for legacy rows where `childSessionID` is absent.
- Log fallback usage separately so the adapter can later remove the compatibility path once old rows are no longer important.

## Live Durable Event Sequence

The legacy `/event` SSE endpoint keeps its existing payload shape and adds `sequence` only when the underlying EventV2 payload is durable.

Example durable SSE message:

```text
data: {"id":"evt_...","type":"session.created","properties":{"sessionID":"ses_...","info":{}},"sequence":{"aggregateID":"ses_...","seq":0,"version":1}}
```

Shape:

```ts
type LegacyEvent = {
  id: string
  type: string
  properties: unknown
  sequence?: {
    aggregateID: string
    seq: number
    version: number
  }
}
```

Field meaning:

- `id` is still the event id for the live SSE message.
- `properties` is unchanged from the existing legacy stream.
- `sequence.aggregateID` is the durable aggregate id. For session and message events this is normally the session id.
- `sequence.seq` is monotonic within one aggregate and starts at `0`.
- `sequence.version` is the durable event schema version, not an opencode application version.
- Non-durable operational events, such as `server.connected`, `server.heartbeat`, and token delta events, omit `sequence`.

Recommended Astron behavior:

- Keep a `lastSeqByAggregateID` guard for events that include `sequence`.
- Drop duplicates or stale durable events where `event.sequence.seq <= lastSeqByAggregateID[event.sequence.aggregateID]`.
- If a gap is detected, trigger a history or sync refresh for that aggregate instead of inventing missing events locally.
- Do not advance any durable cursor from events that omit `sequence`; treat them as live-only operational events.
- Use opencode ids and sequence data as adapter input facts, then project Astron product ids in Astron's own domain layer.

## Compatibility Notes

Both changes are additive:

- Existing `/event` consumers that only read `id`, `type`, and `properties` continue to work.
- Existing stored message readers continue to work because `childSessionID` is optional.
- Astron can roll out support in two steps: consume `childSessionID` from history first, then add `sequence` guards to the live stream.
