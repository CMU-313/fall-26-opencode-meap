export * as MemoryTool from "./memory"

import { ToolFailure } from "@opencode-ai/llm"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { Memory } from "../memory"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "memory"

export const Input = Schema.Struct({
  text: Schema.NonEmptyString.annotate({
    description: 'What to remember, as one short sentence about the user, such as "prefers hints over full answers"',
  }),
})

export const Output = Memory.Info
export type Output = typeof Output.Type

// Receives the encoded output, where branded ids are plain strings.
export const toModelOutput = (output: typeof Output.Encoded) => `Remembered [${output.id}]: ${output.text}`

// The description is what teaches the model when a preference is worth keeping, so it
// is as much a part of this tool's behavior as the code below it.
export const description = [
  "Record something about the user that should shape future conversations, such as how they like to study or be taught.",
  "Use it when the user asks you to remember something, or states a lasting preference about how they learn: for example, that they prefer hints over full answers, study in short blocks, or are preparing for a particular exam.",
  "Do not record one-off requests, details of the current task, or anything private or sensitive.",
  "Memories already recorded are listed in your context; do not record one that is already there.",
  "Write each memory as one short sentence about the user. The user approves every memory before it is saved.",
].join(" ")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const tools = yield* Tools.Service
    const memory = yield* Memory.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service

    // Configuration is read once when the location opens. With memory off, the tool is
    // not offered at all rather than offered and then refused.
    const settings = Config.latest(yield* config.entries(), "memory")
    if (settings?.enabled === false) return

    // Outside a git repository every folder shares one project id, so a project memory
    // recorded there would follow the user into every other such folder. It is recorded
    // as global instead, which is what it would behave as anyway.
    const scoped = settings?.scope === "project" && location.project.id !== ProjectID.global

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              // Asked before anything is written, so declining leaves nothing on disk.
              yield* permission.assert({
                action: name,
                resources: [input.text],
                save: ["*"],
                metadata: { scope: scoped ? "project" : "global" },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              return yield* memory.write(
                scoped
                  ? { text: input.text, scope: "project", project_id: location.project.id }
                  : { text: input.text, scope: "global" },
                { maxEntries: settings?.max_entries },
              )
            }).pipe(
              // The cap's message names a memory to delete, which the model needs in order
              // to tell the user how to make room. Other failures stay generic.
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: error instanceof Memory.LimitExceededError ? error.message : "Unable to record memory",
                  }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memory",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Memory.node, Config.node, Location.node],
})
