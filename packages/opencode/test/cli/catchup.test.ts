import { $ } from "bun"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { buildPrompt } from "../../src/cli/cmd/catchup"
import { Git, type Commit } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node])))

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("catchup", () => {
  describe("buildPrompt()", () => {
    it.live("includes commit hash, author, date, message, and file stats", () =>
      Effect.sync(() => {
        const commits: Commit[] = [
          {
            hash: "abc1234567890",
            author: "Jane Doe",
            email: "jane@example.com",
            date: "2026-10-01T12:00:00Z",
            message: "add login form",
            files: [{ file: "src/login.ts", additions: 10, deletions: 2 }],
          },
        ]

        const prompt = buildPrompt(commits)

        expect(prompt).toContain("abc1234")
        expect(prompt).toContain("Jane Doe")
        expect(prompt).toContain("2026-10-01T12:00:00Z")
        expect(prompt).toContain("add login form")
        expect(prompt).toContain("src/login.ts")
        expect(prompt).toContain("+10/-2")
      }),
    )

    it.live("handles multiple commits, most recent first", () =>
      Effect.sync(() => {
        const commits: Commit[] = [
          {
            hash: "newest111",
            author: "A",
            email: "a@example.com",
            date: "2026-10-02T00:00:00Z",
            message: "newest change",
            files: [],
          },
          {
            hash: "oldest222",
            author: "B",
            email: "b@example.com",
            date: "2026-10-01T00:00:00Z",
            message: "oldest change",
            files: [],
          },
        ]

        const prompt = buildPrompt(commits)
        const newestIndex = prompt.indexOf("newest change")
        const oldestIndex = prompt.indexOf("oldest change")

        expect(newestIndex).toBeGreaterThanOrEqual(0)
        expect(oldestIndex).toBeGreaterThan(newestIndex)
      }),
    )

    it.live("handles commits with no file changes gracefully", () =>
      Effect.sync(() => {
        const commits: Commit[] = [
          {
            hash: "nofiles000",
            author: "C",
            email: "c@example.com",
            date: "2026-10-03T00:00:00Z",
            message: "empty commit",
            files: [],
          },
        ]

        const prompt = buildPrompt(commits)
        expect(prompt).toContain("no file changes recorded")
      }),
    )
  })

  describe("graceful failure paths", () => {
    // it.live("git.log() returns empty array for a repo with no commit history, which the catchup handler treats as the no-history case", () =>
    //   Effect.gen(function* () {
    //     const tmp = yield* scopedTmpdir({ git: true })
    //     const git = yield* Git.Service
    //     const commits = yield* git.log(tmp.path)
    //     expect(commits).toEqual([])
    //   }),
    // )

    it.live("git.log() returns empty array for a non-git directory, which the catchup handler treats as the no-history case", () =>
      Effect.gen(function* () {
        const tmp = yield* scopedTmpdir()
        const git = yield* Git.Service
        const commits = yield* git.log(tmp.path)
        expect(commits).toEqual([])
      }),
    )
  })
})