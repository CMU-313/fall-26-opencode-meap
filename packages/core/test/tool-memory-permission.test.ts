import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Memory } from "@opencode-ai/core/memory"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { MemoryTool } from "@opencode-ai/core/tool/memory"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"
import { agentHost, host } from "./plugin/host"

const it = testEffect(Layer.empty)

const sessionID = SessionV2.ID.make("ses_memory_permission")

// The real permission service holds a pending request in memory, so each test runs
// from start to finish inside one of these layers.
const gate = (root: string) => {
  const directory = AbsolutePath.make(path.join(root, "project"))
  const current = Location.Service.of(location({ directory }))
  const layer = AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      MemoryTool.node,
      Memory.node,
    ]),
    [
      [Global.node, Global.layerWith({ config: path.join(root, "config") })],
      [Location.node, Layer.succeed(Location.Service, current)],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
  // A session to ask on, and the built-in agents exactly as they ship, so the rule
  // under test is the real default rather than a copy of it.
  const setup = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "memory",
        directory,
        title: "memory",
        version: "test",
        agent: "build",
      })
      .run()
      .pipe(Effect.orDie)
    const agents = yield* AgentV2.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provideService(Location.Service, current),
    )
  })
  return { layer, setup }
}

const withRoot = <A, E, R>(body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => body(tmp.path)))

// Collects every approval request the permission service raises from here on.
const watchRequests = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const requests: PermissionV2.Request[] = []
  const next = yield* Deferred.make<PermissionV2.Request>()
  const unsubscribe = yield* events.listen((event) => {
    if (event.type !== PermissionV2.Event.Asked.type) return Effect.void
    requests.push(event.data as PermissionV2.Request)
    return Deferred.succeed(next, event.data as PermissionV2.Request).pipe(Effect.asVoid)
  })
  yield* Effect.addFinalizer(() => unsubscribe)
  return { requests, next: Deferred.await(next) }
})

const remember = (text: string) =>
  ToolRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: `call-${text}`, name: MemoryTool.name, input: { text } },
      }),
    ),
  )

const answer = (request: PermissionV2.Request, reply: PermissionV2.Reply) =>
  PermissionV2.Service.pipe(Effect.flatMap((permission) => permission.reply({ requestID: request.id, reply })))

const recorded = Memory.Service.pipe(Effect.flatMap((memory) => memory.list()))

// Every file in the memory directory with its exact contents, to compare byte for byte.
const directoryContents = (root: string) =>
  Effect.promise(async () => {
    const directory = path.join(root, "config", "memory")
    const names = await fs.readdir(directory).catch(() => [] as string[])
    return Promise.all(
      names.toSorted().map(async (name) => [name, await fs.readFile(path.join(directory, name), "utf8")] as const),
    )
  })

describe("MemoryTool permission", () => {
  it.live("never lets a built-in agent record a memory without asking", () =>
    withRoot((root) => {
      const harness = gate(root)
      return Effect.gen(function* () {
        yield* harness.setup
        const service = yield* AgentV2.Service
        const agents = yield* service.all()
        const effect = (id: string) =>
          PermissionV2.evaluate("memory", "*", agents.find((agent) => agent.id === id)?.permissions ?? []).effect

        // The agents a student talks to ask; background agents may refuse outright.
        expect(effect("build")).toBe("ask")
        expect(effect("plan")).toBe("ask")
        for (const agent of agents)
          expect(PermissionV2.evaluate("memory", "*", agent.permissions).effect).not.toBe("allow")
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("asks before recording, writes nothing while waiting, and records once approved", () =>
    withRoot((root) => {
      const harness = gate(root)
      return Effect.gen(function* () {
        yield* harness.setup
        const watch = yield* watchRequests

        const call = yield* remember("prefers hints over full answers").pipe(Effect.forkScoped)
        const request = yield* watch.next
        expect(request).toMatchObject({ sessionID, action: "memory", resources: ["prefers hints over full answers"] })
        expect(yield* recorded).toEqual([])

        yield* answer(request, "once")
        const result = yield* Fiber.join(call)
        const memories = yield* recorded
        expect(memories).toMatchObject([{ text: "prefers hints over full answers", scope: "global" }])
        expect(result).toEqual({
          type: "text",
          value: `Remembered [${memories[0].id}]: prefers hints over full answers`,
        })
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("leaves the memory directory byte-identical when the user rejects", () =>
    withRoot((root) => {
      const harness = gate(root)
      return Effect.gen(function* () {
        yield* harness.setup
        // An existing memory, so the directory has real contents that must survive.
        yield* Memory.Service.pipe(
          Effect.flatMap((memory) => memory.write({ text: "keeps a paper notebook", scope: "global" })),
        )
        const before = yield* directoryContents(root)
        const watch = yield* watchRequests

        const call = yield* remember("prefers hints over full answers").pipe(Effect.forkScoped)
        yield* answer(yield* watch.next, "reject")
        // Declining ends the call the way the permission service ends every declined
        // request, before the tool reaches its write.
        const exit = yield* Fiber.await(call)
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof PermissionV2.DeclinedError).toBe(true)
        expect(yield* directoryContents(root)).toEqual(before)
      }).pipe(Effect.provide(harness.layer))
    }),
  )

  it.live("stops asking within the project once the user answers always", () =>
    withRoot((root) => {
      const harness = gate(root)
      return Effect.gen(function* () {
        yield* harness.setup
        const watch = yield* watchRequests

        const first = yield* remember("prefers hints over full answers").pipe(Effect.forkScoped)
        yield* answer(yield* watch.next, "always")
        yield* Fiber.join(first)

        // Were this to ask again it would wait forever, so it is bounded.
        const second = yield* remember("studies in twenty five minute blocks").pipe(Effect.timeout("5 seconds"))
        expect(second.type).toBe("text")
        expect(watch.requests).toHaveLength(1)
        expect(yield* recorded).toHaveLength(2)
      }).pipe(Effect.provide(harness.layer))
    }),
  )
})
