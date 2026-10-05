export * as ConfigMemory from "./memory"

import { Schema } from "effect"
import { Memory } from "@opencode-ai/schema/memory"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.Memory")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Remember study preferences across conversations and give them to the model (default: true)",
  }),
  scope: Memory.Scope.pipe(Schema.optional).annotate({
    description: "Whether newly recorded memories apply everywhere or only to the current project (default: global)",
  }),
  max_entries: PositiveInt.pipe(Schema.optional).annotate({
    description:
      "Maximum number of memories to keep. Recording beyond it is refused rather than evicting one (default: 100)",
  }),
}) {}
