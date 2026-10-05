import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  csvExportStats,
  exportPath,
  jsonExportStats,
  mdExportStats,
  renderCsv,
  renderMarkdown,
  reportStats,
  shapeStats,
  writeExport,
  type SessionStats,
} from "../../src/cli/cmd/stats"

// A model id containing a comma and a quote exercises CSV field escaping
const AWKWARD_MODEL = 'vendor/model,"v2"'

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalSessions: 7,
    totalMessages: 12,
    totalCost: 12.3456789,
    totalTokens: { input: 30467, output: 4336, reasoning: 512, cache: { read: 43008, write: 1024 } },
    toolUsage: { read: 14, bash: 9, edit: 3 },
    modelUsage: {
      "anthropic/claude-opus-5": {
        messages: 6,
        tokens: { input: 20000, output: 3000, cache: { read: 40000, write: 1000 } },
        cost: 9.87654,
      },
      [AWKWARD_MODEL]: {
        messages: 4,
        tokens: { input: 8000, output: 1000, cache: { read: 3000, write: 24 } },
        cost: 2.4691,
      },
      "opencode/big-pickle": {
        messages: 2,
        tokens: { input: 2467, output: 336, cache: { read: 8, write: 0 } },
        cost: 0,
      },
    },
    dateRange: { earliest: 1787788558233, latest: 1789411900040 },
    days: 19,
    costPerDay: 0.6497726,
    tokensPerSession: 11115.857142857143,
    medianTokensPerSession: 9000,
    ...overrides,
  }
}

const EMPTY: SessionStats = stats({
  totalSessions: 0,
  totalMessages: 0,
  totalCost: 0,
  totalTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  toolUsage: {},
  modelUsage: {},
  // aggregateSessionStats leaves these as NaN when it divides by zero sessions
  costPerDay: NaN,
  tokensPerSession: NaN,
  medianTokensPerSession: NaN,
  days: 0,
})

/** Quote-aware CSV row split, so escaped fields compare as single values. */
function parseCsv(body: string) {
  return body
    .trim()
    .split("\n")
    .map((line) => {
      const fields: string[] = []
      let field = ""
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (quoted && char === '"' && line[i + 1] === '"') {
          field += '"'
          i++
          continue
        }
        if (char === '"') {
          quoted = !quoted
          continue
        }
        if (char === "," && !quoted) {
          fields.push(field)
          field = ""
          continue
        }
        field += char
      }
      fields.push(field)
      return fields
    })
}

/** Every payload leaf keyed as scope|id|metric, the shape CSV rows take. */
function leaves(payload: ReturnType<typeof shapeStats>) {
  const out = new Map<string, string>()
  for (const section of ["meta", "overview", "tokens"] as const) {
    for (const [metric, value] of Object.entries(payload[section])) out.set(`${section}||${metric}`, String(value))
  }
  for (const model of payload.models) {
    for (const [metric, value] of Object.entries(model)) {
      if (metric === "id") continue
      out.set(`model|${model.id}|${metric}`, String(value))
    }
  }
  for (const tool of payload.tools) out.set(`tool|${tool.name}|calls`, String(tool.calls))
  return out
}

describe("stats export consistency", () => {
  test("csv carries exactly the payload's leaves, with identical values", () => {
    const payload = shapeStats(stats())
    const rows = parseCsv(renderCsv(payload))

    expect(rows[0]).toEqual(["scope", "scope_id", "metric", "value"])

    const actual = new Map(rows.slice(1).map((row) => [`${row[0]}|${row[1]}|${row[2]}`, row[3]]))
    expect(actual).toEqual(leaves(payload))
  })

  test("json round-trips the same payload csv was built from", () => {
    const payload = shapeStats(stats())
    // The json path writes JSON.stringify(shapeStats(...)), so a round-trip must
    // preserve every leaf csv reports.
    expect(leaves(JSON.parse(JSON.stringify(payload)))).toEqual(leaves(payload))
  })

  test("markdown states every payload number", () => {
    const payload = shapeStats(stats())
    // Thousands separators are presentation only; strip them rather than
    // reimplementing the formatter here.
    const flat = renderMarkdown(payload).replaceAll(",", "")
    for (const value of leaves(payload).values()) {
      if (value === "") continue
      expect(flat).toContain(value.replaceAll(",", ""))
    }
  })

  test("every format orders models and tools the same way", () => {
    const payload = shapeStats(stats())
    const expected = payload.models.map((model) => model.id)
    expect(expected).toEqual(["anthropic/claude-opus-5", AWKWARD_MODEL, "opencode/big-pickle"])

    const csvOrder = parseCsv(renderCsv(payload))
      .slice(1)
      .filter((row) => row[0] === "model" && row[2] === "messages")
      .map((row) => row[1])
    expect(csvOrder).toEqual(expected)

    const md = renderMarkdown(payload)
    const positions = expected.map((id) => md.indexOf(id))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))

    expect(payload.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit"])
  })

  test("csv escapes a model id containing a comma and a quote", () => {
    const rows = parseCsv(renderCsv(shapeStats(stats())))
    for (const row of rows) expect(row).toHaveLength(4)
    expect(rows.some((row) => row[1] === AWKWARD_MODEL)).toBe(true)
  })

  test("limits apply identically across formats", () => {
    const payload = shapeStats(stats(), 2, 1)
    expect(payload.models).toHaveLength(1)
    expect(payload.tools).toHaveLength(2)

    const rows = parseCsv(renderCsv(payload)).slice(1)
    expect(new Set(rows.filter((row) => row[0] === "model").map((row) => row[1])).size).toBe(1)
    expect(rows.filter((row) => row[0] === "tool")).toHaveLength(2)

    const md = renderMarkdown(payload)
    expect(md).not.toContain("opencode/big-pickle")
    expect(md).not.toContain("| `edit` |")
  })

  test("absent limits export everything, unlike the terminal renderer", () => {
    const payload = shapeStats(stats())
    expect(payload.models).toHaveLength(3)
    expect(payload.tools).toHaveLength(3)
  })

  test("machine formats carry no human formatting", () => {
    const payload = shapeStats(stats())
    for (const row of parseCsv(renderCsv(payload)).slice(1)) {
      expect(row[3]).not.toContain("$")
      expect(row[3]).not.toContain(",")
      expect(row[3]).not.toMatch(/\d[KM]$/)
    }
    expect(JSON.stringify(payload)).not.toContain("$")
  })

  test("an empty dataset produces zeros, not NaN", () => {
    const payload = shapeStats(EMPTY)
    const json = JSON.stringify(payload)
    expect(json).not.toContain("NaN")
    expect(json).not.toContain("null")
    for (const value of Object.values(payload.overview)) expect(Number.isFinite(value)).toBe(true)

    // dateRange is seeded with Date.now()/0, so it must not surface as a 1970 date.
    expect(payload.meta.earliest).toBe("")
    expect(payload.meta.latest).toBe("")

    const rows = parseCsv(renderCsv(payload))
    expect(rows[0]).toEqual(["scope", "scope_id", "metric", "value"])
    expect(rows.slice(1).some((row) => row[0] === "model" || row[0] === "tool")).toBe(false)
    for (const row of rows.slice(1)) expect(row[3]).not.toBe("NaN")

    const md = renderMarkdown(payload)
    expect(md).toContain("_No model usage recorded._")
    expect(md).toContain("_No tool usage recorded._")
  })

  test("rounding happens once, so no format shows more precision than another", () => {
    const payload = shapeStats(stats())
    expect(payload.overview.cost_usd).toBe(12.3457)
    expect(payload.models[0].cost_usd).toBe(9.8765)
    // Every cost the payload holds must appear verbatim in markdown.
    const md = renderMarkdown(payload)
    expect(md).toContain(`$${payload.overview.cost_usd}`)
    expect(md).toContain(`$${payload.models[0].cost_usd}`)
  })
})

/** Cell count of table row. Escaped pipes do not open a new cell. */
function cells(row: string) {
  return row.replaceAll("\\|", "").split("|").length
}

// These pin behavior the first ten tests leave open. Each one corresponds to a
// path that currently either crashes, emits a non-number, or corrupts the
// format it is writing.
describe("stats export edge cases", () => {
  test("a NaN token count never reaches the output", () => {
    // round() guards `overview` but `tokens` is read raw, so a single bad
    // counter becomes null in json and poisons the computed total.
    const payload = shapeStats(stats({ totalTokens: { input: NaN, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }))

    expect(Number.isFinite(payload.tokens.input)).toBe(true)
    expect(Number.isFinite(payload.tokens.total)).toBe(true)

    const json = JSON.stringify(payload)
    expect(json).not.toContain("NaN")
    expect(json).not.toContain("null")

    for (const row of parseCsv(renderCsv(payload)).slice(1)) {
      expect(row[3]).not.toBe("NaN")
      expect(row[3]).not.toBe("null")
    }
  })

  test("a malformed dateRange degrades instead of throwing", () => {
    // new Date(NaN).toISOString() throws RangeError. The existing guard only
    // covers totalSessions === 0, so one bad session row crashes the export.
    const broken = stats({ dateRange: { earliest: NaN, latest: NaN } })
    expect(() => shapeStats(broken)).not.toThrow()
    expect(shapeStats(broken).meta.earliest).toBe("")
    expect(shapeStats(broken).meta.latest).toBe("")
  })

  test("an epoch-zero dateRange is not reported as 1970", () => {
    const payload = shapeStats(stats({ dateRange: { earliest: 0, latest: 0 } }))
    expect(payload.meta.earliest).not.toContain("1970")
    expect(payload.meta.latest).not.toContain("1970")
  })

  test("a model id containing a pipe does not break the markdown table", () => {
    const payload = shapeStats(
      stats({
        modelUsage: {
          "vendor|model": { messages: 1, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }, cost: 0 },
        },
      }),
    )
    const md = renderMarkdown(payload)
    const header = md.split("\n").find((line) => line.startsWith("| Model |"))
    const row = md.split("\n").find((line) => line.includes("vendor"))

    expect(header).toBeDefined()
    expect(row).toBeDefined()
    // Backticks do not protect pipes in GFM: an unescaped one adds a cell and
    // shifts every column after it.
    expect(cells(row!)).toBe(cells(header!))
  })

  test("a negative limit does not silently drop entries", () => {
    // slice(0, -1) trims from the end, so --models -1 hides the least-used
    // model instead of reporting a bad argument.
    const full = shapeStats(stats())
    const negative = shapeStats(stats(), -1, -1)

    expect(negative.models).toHaveLength(full.models.length)
    expect(negative.tools).toHaveLength(full.tools.length)
  })

  test("an Infinite aggregate collapses to zero like NaN does", () => {
    const payload = shapeStats(stats({ totalCost: Infinity, costPerDay: -Infinity }))
    expect(payload.overview.cost_usd).toBe(0)
    expect(payload.overview.cost_per_day_usd).toBe(0)
  })
})

// The export path is pure; the writers need a real file, so they get a tmpdir
// each rather than writing into the package directory.
async function scratchDir() {
  return await mkdtemp(join(tmpdir(), "stats-export-"))
}

describe("stats export writers", () => {
  test("exportPath builds the documented filename", () => {
    expect(exportPath("csv", "/tmp/somewhere", 1700000000000)).toBe(
      join("/tmp/somewhere", "opencode_stats_1700000000000.csv"),
    )
  })

  test("exportPath defaults to the working directory and the current time", () => {
    expect(exportPath("json", undefined, 1)).toBe(join(process.cwd(), "opencode_stats_1.json"))
    expect(exportPath("md")).toStartWith(join(process.cwd(), "opencode_stats_"))
    expect(exportPath("md")).toEndWith(".md")
  })

  test("each exporter writes its own format to the path it is given", async () => {
    const directory = await scratchDir()
    const fixture = stats()

    const json = join(directory, "out.json")
    await Effect.runPromise(jsonExportStats(fixture, undefined, undefined, json))
    expect(JSON.parse(await readFile(json, "utf8")).overview.sessions).toBe(fixture.totalSessions)

    const csv = join(directory, "out.csv")
    await Effect.runPromise(csvExportStats(fixture, undefined, undefined, csv))
    expect(await readFile(csv, "utf8")).toStartWith("scope,scope_id,metric,value")

    const md = join(directory, "out.md")
    await Effect.runPromise(mdExportStats(fixture, undefined, undefined, md))
    expect(await readFile(md, "utf8")).toStartWith("# opencode usage stats")

    await rm(directory, { recursive: true, force: true })
  })

  test("writeExport returns the path and announces it on stderr, not stdout", async () => {
    const directory = await scratchDir()
    const target = join(directory, "announced.json")

    const err = spyOn(process.stderr, "write").mockImplementation(() => true)
    const out = spyOn(process.stdout, "write").mockImplementation(() => true)
    const returned = await Effect.runPromise(writeExport("{}", target))
    const stderr = err.mock.calls.flat().join("")
    const stdout = out.mock.calls.flat().join("")
    err.mockRestore()
    out.mockRestore()

    expect(returned).toBe(target)
    expect(stderr).toContain(target)
    // stdout has to stay clean or `--export json | jq` breaks.
    expect(stdout).not.toContain(target)

    await rm(directory, { recursive: true, force: true })
  })

  test("an unwritable target fails as a CliError rather than a defect", async () => {
    const directory = await scratchDir()
    // Effect.result only captures typed failures — a defect would reject the
    // promise instead, so a Failure here proves the error channel is typed.
    const target = join(directory, "no-such-subdirectory", "out.json")
    const result = await Effect.runPromise(Effect.result(writeExport("{}", target)))

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toContain("Could not write")

    await rm(directory, { recursive: true, force: true })
  })

  test("reportStats dispatches to the requested format and writes nothing by default", async () => {
    const directory = await scratchDir()
    const fixture = stats()

    for (const [format, marker] of [
      ["json", '"overview"'],
      ["csv", "scope,scope_id"],
      ["md", "# opencode usage stats"],
    ] as const) {
      const target = join(directory, `dispatch.${format}`)
      await Effect.runPromise(reportStats(fixture, undefined, undefined, format, target))
      expect(await readFile(target, "utf8")).toContain(marker)
    }

    // The default branch renders to the terminal; silence it and assert that no
    // file appeared, which covers the dispatch without asserting on displayStats.
    const before = (await readdir(directory)).length
    const log = spyOn(console, "log").mockImplementation(() => {})
    await Effect.runPromise(reportStats(fixture, undefined, undefined, undefined, join(directory, "unused")))
    log.mockRestore()
    expect((await readdir(directory)).length).toBe(before)

    await rm(directory, { recursive: true, force: true })
  })
})
