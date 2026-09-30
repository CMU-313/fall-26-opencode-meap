import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigParse } from "../../src/config/parse"

// The legacy engine, which the TUI runs on, rejects unknown top-level keys outright.
// These tests pin that a memory section is accepted, and that a bad value is reported
// against the exact key the user has to fix.
describe("memory configuration in the legacy config parser", () => {
  test("accepts a memory section instead of rejecting it as an unrecognized key", () => {
    const config = ConfigParse.schema(
      ConfigV1.Info,
      { memory: { enabled: false, scope: "project", max_entries: 20 } },
      "test",
    )
    expect(config.memory).toEqual({ enabled: false, scope: "project", max_entries: 20 })
  })

  test("reports an invalid max_entries at the memory.max_entries path", () => {
    for (const max_entries of [0, -3, "ten"]) {
      try {
        ConfigParse.schema(ConfigV1.Info, { memory: { max_entries } }, "test")
        throw new Error("expected config parse to fail")
      } catch (err) {
        const error = err as { data?: { issues?: Array<{ path?: string[]; message?: string }> } }
        expect(error.data?.issues).toEqual([expect.objectContaining({ path: ["memory", "max_entries"] })])
      }
    }
  })
})
