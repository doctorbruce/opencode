export * as SessionCompactionEvent from "./session-compaction-event"

import { Event } from "./event"
import { optional } from "./schema"
import { SessionID } from "./session-id"
import { SessionV1 } from "./v1/session"
import { Schema } from "effect"

export const Started = Event.define({
  type: "session.compaction.started",
  schema: {
    sessionID: SessionID,
    messageID: SessionV1.MessageID,
    afterMessageID: optional(SessionV1.MessageID),
    reason: Schema.Literals(["manual", "auto"]),
  },
})

export const Compacted = Event.define({
  type: "session.compacted",
  schema: {
    sessionID: SessionID,
    messageID: SessionV1.MessageID,
    afterMessageID: optional(SessionV1.MessageID),
    reason: Schema.Literals(["manual", "auto"]),
  },
})

export const Definitions = Event.inventory(Started, Compacted)
