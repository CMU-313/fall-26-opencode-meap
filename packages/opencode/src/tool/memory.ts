import { Effect, Schema } from "effect"
import { Memory } from "@opencode-ai/core/memory"
import { description, Input, toModelOutput } from "@opencode-ai/core/tool/memory"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"

type Metadata = {
  text: string
  scope: Memory.Scope
}

// The legacy engine's counterpart of the v2 memory tool. The description, input shape,
// and model output come from core, so the model is taught and answered identically in
// both engines.
export const MemoryTool = Tool.define<typeof Input, Metadata, Memory.Service | Config.Service>(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const config = yield* Config.Service

    return {
      description,
      parameters: Input,
      execute: (params: Schema.Schema.Type<typeof Input>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const settings = (yield* config.get()).memory
          const instance = yield* InstanceState.context
          // Outside a git repository every folder shares one project id, so a project
          // memory recorded there would follow the user into every other such folder. It
          // is recorded as global instead, which is what it would behave as anyway.
          const scope = settings?.scope === "project" && instance.project.id !== ProjectID.global ? "project" : "global"

          // Asked before anything is written, so declining leaves nothing on disk.
          yield* ctx.ask({
            permission: "memory",
            patterns: [params.text],
            always: ["*"],
            metadata: { text: params.text, scope },
          })

          const info = yield* memory
            .write(
              scope === "project"
                ? { text: params.text, scope, project_id: instance.project.id }
                : { text: params.text, scope },
              { maxEntries: settings?.max_entries },
            )
            .pipe(
              // The cap's message names a memory to delete, which the model needs in order
              // to tell the user how to make room.
              Effect.catchTag("Memory.LimitExceededError", (error) => Effect.die(new Error(error.message))),
            )

          return {
            title: params.text,
            output: toModelOutput(info),
            metadata: { text: info.text, scope: info.scope },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Input, Metadata>
  }),
)
