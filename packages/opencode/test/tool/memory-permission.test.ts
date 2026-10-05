import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Memory } from "@opencode-ai/core/memory"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { MemoryTool } from "@/tool/memory"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { TestConfig } from "../fixture/config"
import { it, pollWithTimeout } from "../lib/effect"

const sessionID = SessionID.make("ses_memory_permission")

// The real permission service and the built-in agents exactly as they ship, so the
// rule under test is the real default rather than a copy of it.
const gate = (config: string, settings: Partial<ConfigV1.Info> = {}) =>
  LayerNode.compile(LayerNode.group([Permission.node, Agent.node, Memory.node, Config.node, Truncate.node]), [
    [Global.node, Global.layerWith({ config })],
    [Config.node, TestConfig.layer({ get: () => Effect.succeed(settings) })],
  ])

// Memories live under core's Global config directory. Each test points it inside its
// own temporary project so tests never see one another's memories.
const memoryConfig = InstanceState.context.pipe(Effect.map((ctx) => path.join(ctx.directory, ".memory-config")))

// Connects the tool to the permission service the way a real session does
// (src/session/tools.ts): the agent's rules travel with each request, and an
// unanswerable request ends the call.
const remember = (text: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const agents = yield* Agent.Service
    const build = yield* agents.get("build")
    const ctx: Tool.Context = {
      sessionID,
      messageID: MessageID.make("msg_memory_permission"),
      callID: `call-${text}`,
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: (req) => permission.ask({ ...req, sessionID, ruleset: build?.permission ?? [] }).pipe(Effect.orDie),
    }
    const tool = yield* Tool.init(yield* MemoryTool)
    return yield* tool.execute({ text }, ctx)
  })

const pending = (message: string) =>
  pollWithTimeout(
    Permission.Service.pipe(
      Effect.flatMap((permission) => permission.list()),
      Effect.map((requests) => requests[0]),
    ),
    message,
  )

const answer = (request: PermissionV1.Request, reply: PermissionV1.Reply) =>
  Permission.Service.pipe(Effect.flatMap((permission) => permission.reply({ requestID: request.id, reply })))

const recorded = Memory.Service.pipe(Effect.flatMap((memory) => memory.list()))

// Every file in the memory directory with its exact contents, to compare byte for byte.
const directoryContents = (config: string) =>
  Effect.promise(async () => {
    const directory = path.join(config, "memory")
    const names = await fs.readdir(directory).catch(() => [] as string[])
    return Promise.all(
      names.toSorted().map(async (name) => [name, await fs.readFile(path.join(directory, name), "utf8")] as const),
    )
  })

describe("tool.memory permission", () => {
  it.instance("never lets a built-in agent record a memory without asking", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const agents = yield* Agent.Service
        const all = yield* agents.list()
        const action = (name: string) =>
          Permission.evaluate("memory", "*", all.find((agent) => agent.name === name)?.permission ?? []).action

        // The agents a student talks to ask; others may refuse outright.
        expect(action("build")).toBe("ask")
        expect(action("plan")).toBe("ask")
        for (const agent of all) expect(Permission.evaluate("memory", "*", agent.permission).action).not.toBe("allow")
      }).pipe(Effect.provide(gate(yield* memoryConfig)))
    }),
  )

  it.instance("lets a user opt into recording without a prompt from their own settings", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        expect(Permission.evaluate("memory", "*", build?.permission ?? []).action).toBe("allow")
      }).pipe(Effect.provide(gate(yield* memoryConfig, { permission: { memory: "allow" } })))
    }),
  )

  it.instance("asks before recording, writes nothing while waiting, and records once approved", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const call = yield* remember("prefers hints over full answers").pipe(Effect.forkScoped)
        const request = yield* pending("no approval prompt was raised")
        expect(request).toMatchObject({
          sessionID,
          permission: "memory",
          patterns: ["prefers hints over full answers"],
        })
        expect(yield* recorded).toEqual([])

        yield* answer(request, "once")
        const result = yield* Fiber.join(call)
        const memories = yield* recorded
        expect(memories).toMatchObject([{ text: "prefers hints over full answers" }])
        expect(result.output).toBe(`Remembered [${memories[0].id}]: prefers hints over full answers`)
      }).pipe(Effect.provide(gate(yield* memoryConfig)))
    }),
  )

  it.instance("leaves the memory directory byte-identical when the user rejects", () =>
    Effect.gen(function* () {
      const config = yield* memoryConfig
      yield* Effect.gen(function* () {
        // An existing memory, so the directory has real contents that must survive.
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "keeps a paper notebook", scope: "global" })),
        )
        const before = yield* directoryContents(config)

        const call = yield* remember("prefers hints over full answers").pipe(Effect.forkScoped)
        yield* answer(yield* pending("no approval prompt was raised"), "reject")
        const exit = yield* Fiber.await(call)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV1.RejectedError).toBe(true)
        expect(yield* directoryContents(config)).toEqual(before)
      }).pipe(Effect.provide(gate(config)))
    }),
  )

  it.instance("stops asking for the rest of the run once the user answers always", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const first = yield* remember("prefers hints over full answers").pipe(Effect.forkScoped)
        yield* answer(yield* pending("no approval prompt was raised"), "always")
        yield* Fiber.join(first)

        // The legacy engine keeps "always" in memory for the running instance, so this
        // holds until opencode restarts. Were it to ask again it would wait forever,
        // so it is bounded.
        const second = yield* remember("studies in twenty five minute blocks").pipe(Effect.timeout("5 seconds"))
        expect(second.output).toContain("studies in twenty five minute blocks")
        expect(yield* recorded).toHaveLength(2)
        const permission = yield* Permission.Service
        expect(yield* permission.list()).toEqual([])
      }).pipe(Effect.provide(gate(yield* memoryConfig)))
    }),
  )
})
