import { describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import fc from "fast-check"
import { Global } from "@opencode-ai/core/global"
import { CliError } from "../../src/cli/effect-cmd"
import {
  exportStats,
  renderCsv,
  renderMarkdown,
  reportStats,
  resolveExportDir,
  shapeStats,
  type SessionStats,
} from "../../src/cli/cmd/stats"

// Fixed so Stryker results are reproducible: every run checks the same inputs.
fc.configureGlobal({ seed: 42 })

type Payload = ReturnType<typeof shapeStats>

const nat = (max: number) => fc.nat({ max })
const real = (max: number) => fc.double({ min: 0, max, noNaN: true, noDefaultInfinity: true })

const nanOr = (arb: fc.Arbitrary<number>) => fc.oneof(arb, fc.constant(NaN))
const tokens = nat(1e12)
const cache = fc.record({ read: tokens, write: tokens })
const usd = real(100_000)
// Mostly real session times, plus the aggregator's "unset" values and the
// edges of the range Date can represent (8.64e15 ms).
const timestamp = fc.oneof(
  fc.integer({ min: 1.6e12, max: 1.9e12 }),
  fc.integer({ min: 1.6e12, max: 1.9e12 }),
  fc.constantFrom(0, -1, NaN, 8.64e15, 8.64e15 + 1),
)

const statsArb: fc.Arbitrary<SessionStats> = fc.record({
  totalSessions: fc.oneof(fc.constant(0), nat(100_000)),
  totalMessages: nat(10_000_000),
  totalCost: usd,
  totalTokens: fc.record({ input: tokens, output: tokens, reasoning: tokens, cache }),
  toolUsage: fc.dictionary(fc.stringMatching(/^[a-z][a-z_,"|`]{0,11}$/), nat(1e6), { maxKeys: 6 }),
  modelUsage: fc.dictionary(
    fc.stringMatching(/^[a-z0-9]{1,8}\/[a-z0-9.,"|`-]{1,12}$/),
    fc.record({ messages: nat(100_000), tokens: fc.record({ input: tokens, output: tokens, cache }), cost: usd }),
    { maxKeys: 6 },
  ),
  dateRange: fc.record({ earliest: timestamp, latest: timestamp }),
  days: nat(3650),
  costPerDay: nanOr(usd),
  tokensPerSession: nanOr(real(1e12)),
  medianTokensPerSession: nanOr(real(1e12)),
})

const EXAMPLE = fc.sample(statsArb, { numRuns: 1, seed: 1 })[0]

const withoutClock = (payload: Payload) => ({ ...payload, meta: { ...payload.meta, generated_at: "" } })

const reversed = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).reverse())

/** R1 needs the same numbers and models, not the same row order, so compare rows by id. */
const byId = (payload: Payload) => ({
  ...withoutClock(payload),
  models: payload.models.toSorted((a, b) => a.id.localeCompare(b.id)),
  tools: payload.tools.toSorted((a, b) => a.name.localeCompare(b.name)),
})

/** One key scheme shared by every format, matching the csv scope names. */
const key = (scope: string, id: string, metric: string) => `${scope}:${id}.${metric}`

/** Every number in the payload, keyed format-neutrally. */
function flatten({ overview, tokens, models, tools }: Omit<Payload, "meta">) {
  return Object.fromEntries([
    ...Object.entries(overview).map(([metric, value]) => [key("overview", "", metric), value]),
    ...Object.entries(tokens).map(([metric, value]) => [key("tokens", "", metric), value]),
    ...models.flatMap(({ id, ...rest }) =>
      Object.entries(rest).map(([metric, value]) => [key("model", id, metric), value]),
    ),
    ...tools.map((tool) => [key("tool", tool.name, "calls"), tool.calls]),
  ])
}

/** CSV body rows with quoted fields unescaped; generated ids never contain newlines. */
const csvRows = (body: string) =>
  body
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const raw = [...line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)].map(([, field]) => field)
      const [scope, id, metric, value] = raw.map((field) =>
        field.startsWith('"') ? field.slice(1, -1).replaceAll('""', '"') : field,
      )
      return { scope, id, metric, value, rawValue: raw[3] }
    })

const fromCsv = (body: string) =>
  Object.fromEntries(
    csvRows(body)
      .filter((row) => row.scope !== "meta")
      .map((row) => [key(row.scope, row.id, row.metric), Number(row.value)]),
  )

// The markdown tables list each section's metrics in payload order.
const SHAPE = shapeStats(EXAMPLE)
const MODEL_METRICS = ["messages", "input", "output", "cache_read", "cache_write", "cost_usd"]

/** Rebuilds the payload from the markdown tables so it can go through flatten(). */
function fromMarkdown(body: string) {
  const [overview, tokens, models, tools] = body
    .split("\n## ")
    .slice(1)
    .map((section) =>
      section
        .split("\n")
        .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
        .slice(1)
        .map((line) => line.slice(2, -2).split(/(?<!\\) \| /)),
    )
  const num = (cell: string) => Number(cell.replace(/[$,*]/g, ""))
  // Longer fences pad the value with a space on each side.
  const id = (cell: string) => {
    const fence = cell.match(/^`+/)![0].length
    const inner = cell.slice(fence, -fence)
    return (fence > 1 ? inner.slice(1, -1) : inner).replaceAll("\\|", "|")
  }
  const zip = (metrics: string[], cells: string[]) => Object.fromEntries(metrics.map((m, i) => [m, num(cells[i])]))
  return {
    overview: zip(
      Object.keys(SHAPE.overview),
      overview.map((row) => row[1]),
    ),
    tokens: zip(
      Object.keys(SHAPE.tokens),
      tokens.map((row) => row[1]),
    ),
    models: models.map(([cell, ...cells]) => ({ id: id(cell), ...zip(MODEL_METRICS, cells) })),
    tools: tools.map(([cell, calls]) => ({ name: id(cell), calls: num(calls) })),
  } as Omit<Payload, "meta">
}

/** GFM code span rule: the fence closes the span, so no backtick run inside may match its length. */
function isCodeSpan(cell: string) {
  const fence = cell.match(/^`+/)?.[0]
  if (!fence || !cell.endsWith(fence) || cell.length < fence.length * 2) return false
  const inner = cell.slice(fence.length, -fence.length)
  return !(inner.match(/`+/g) ?? []).some((run) => run.length === fence.length)
}

/** Inverse of shapeStats, so an export can be fed back through the exporter. */
function statsFromPayload({ meta, overview, tokens, models, tools }: Payload): SessionStats {
  const cache = (row: { cache_read: number; cache_write: number }) => ({ read: row.cache_read, write: row.cache_write })
  const time = (iso: string) => (iso ? Date.parse(iso) : 0)
  return {
    totalSessions: overview.sessions,
    totalMessages: overview.messages,
    totalCost: overview.cost_usd,
    costPerDay: overview.cost_per_day_usd,
    tokensPerSession: overview.tokens_per_session,
    medianTokensPerSession: overview.median_tokens_per_session,
    totalTokens: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cache: cache(tokens) },
    toolUsage: Object.fromEntries(tools.map((tool) => [tool.name, tool.calls])),
    modelUsage: Object.fromEntries(
      models.map((m) => [
        m.id,
        { messages: m.messages, cost: m.cost_usd, tokens: { input: m.input, output: m.output, cache: cache(m) } },
      ]),
    ),
    dateRange: { earliest: time(meta.earliest), latest: time(meta.latest) },
    days: meta.days,
  }
}

describe("stats export properties", () => {
  // Acceptance: using model A then B vs model B then A gives identical totals,
  // averages, per-model rows. Tied rows may swap places; their values may not.
  test("R1 metamorphic: reversing model and tool order leaves the exported numbers and models unchanged", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const swapped = { ...stats, modelUsage: reversed(stats.modelUsage), toolUsage: reversed(stats.toolUsage) }
        expect(byId(shapeStats(swapped))).toEqual(byId(shapeStats(stats)))
      }),
    )
  })

  test("R1 invariant: model and tool rows are exactly the ones used, ordered by message and call count", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const { models, tools } = shapeStats(stats)
        expect(models.map((row) => row.id).sort()).toEqual(Object.keys(stats.modelUsage).sort())
        for (const row of models) expect(row.messages).toBe(stats.modelUsage[row.id].messages)
        for (let i = 1; i < models.length; i++) expect(models[i - 1].messages).toBeGreaterThanOrEqual(models[i].messages)
        expect(tools.map((row) => row.name).sort()).toEqual(Object.keys(stats.toolUsage).sort())
        for (let i = 1; i < tools.length; i++) expect(tools[i - 1].calls).toBeGreaterThanOrEqual(tools[i].calls)
      }),
    )
  })

  // Acceptance: the parsed contents of every format carry the same values.
  test("R2 round-trip: parsing the json, csv and md exports recovers the same numbers", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const payload = shapeStats(stats)
        const expected = flatten(payload)
        expect(flatten(JSON.parse(JSON.stringify(payload)))).toEqual(expected)
        expect(fromCsv(renderCsv(payload))).toEqual(expected)
        expect(flatten(fromMarkdown(renderMarkdown(payload)))).toEqual(expected)
      }),
    )
  })

  // The terminal table shows costs to 2 places and tokens as 1.2K/3.4M, so the
  // oracle is the SessionStats it renders from, not its printed text.
  test("R2 oracle: every exported number matches the CLI's stats to 3 decimal places", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const { overview, tokens, models, tools } = shapeStats(stats)
        const finite = (value: number) => (Number.isFinite(value) ? value : 0)
        expect(overview.sessions).toBe(stats.totalSessions)
        expect(overview.messages).toBe(stats.totalMessages)
        expect(overview.cost_usd).toBeCloseTo(stats.totalCost, 3)
        expect(overview.cost_per_day_usd).toBeCloseTo(finite(stats.costPerDay), 3)
        expect(overview.tokens_per_session).toBeCloseTo(finite(stats.tokensPerSession), 3)
        expect(overview.median_tokens_per_session).toBeCloseTo(finite(stats.medianTokensPerSession), 3)
        expect(tokens.input).toBe(stats.totalTokens.input)
        expect(tokens.output).toBe(stats.totalTokens.output)
        expect(tokens.reasoning).toBe(stats.totalTokens.reasoning)
        expect(tokens.cache_read).toBe(stats.totalTokens.cache.read)
        expect(tokens.cache_write).toBe(stats.totalTokens.cache.write)
        for (const model of models) {
          const usage = stats.modelUsage[model.id]
          expect(model.input).toBe(usage.tokens.input)
          expect(model.output).toBe(usage.tokens.output)
          expect(model.cache_read).toBe(usage.tokens.cache.read)
          expect(model.cache_write).toBe(usage.tokens.cache.write)
          expect(model.cost_usd).toBeCloseTo(usage.cost, 3)
        }
        for (const tool of tools) expect(tool.calls).toBe(stats.toolUsage[tool.name])
      }),
    )
  })

  // Acceptance: "for the same flags" -- --models/--tools cut every format the
  // same way, and an absent or nonsensical limit means "everything".
  const limit = fc.oneof(fc.constant(undefined), nat(8), fc.constantFrom(-1, NaN, Infinity))
  test("R2 flags: --models/--tools keep the busiest N rows, and a missing or invalid limit keeps them all", () => {
    fc.assert(
      fc.property(statsArb, limit, limit, (stats, toolLimit, modelLimit) => {
        const all = shapeStats(stats)
        const limited = shapeStats(stats, toolLimit, modelLimit)
        const kept = (n: number | undefined, rows: number) =>
          n === undefined || Number.isNaN(n) || n < 0 ? rows : Math.min(n, rows)
        expect(limited.models).toEqual(all.models.slice(0, kept(modelLimit, all.models.length)))
        expect(limited.tools).toEqual(all.tools.slice(0, kept(toolLimit, all.tools.length)))
      }),
    )
  })

  // Acceptance: exports carry every field the CLI prints, including the date
  // window. With no sessions, or a date Date can't represent, it is left empty.
  test("R2 meta: every format reports the same date window, empty when there is no usable date", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const payload = shapeStats(stats)
        const usable = (t: number) => stats.totalSessions > 0 && t > 0 && t <= 8.64e15
        expect(payload.meta.days).toBe(stats.days)
        expect(payload.meta.earliest).toBe(usable(stats.dateRange.earliest) ? new Date(stats.dateRange.earliest).toISOString() : "")
        expect(payload.meta.latest).toBe(usable(stats.dateRange.latest) ? new Date(stats.dateRange.latest).toISOString() : "")

        const csvMeta = csvRows(renderCsv(payload)).filter((row) => row.scope === "meta")
        expect(csvMeta.map(({ id, metric, value }) => ({ id, metric, value }))).toEqual(
          Object.entries(payload.meta).map(([metric, value]) => ({ id: "", metric, value: String(value) })),
        )

        const window = payload.meta.earliest ? ` · ${payload.meta.earliest} → ${payload.meta.latest}` : ""
        expect(renderMarkdown(payload).split("\n")[2]).toBe(
          `Generated \`${payload.meta.generated_at}\` · ${payload.meta.days} day window${window}`,
        )
      }),
    )
  })

  // The md export has to stay readable as a document, not just parseable by
  // the lenient reader above: one GFM table (or a placeholder) per section.
  test("R2 markdown: the md export is well-formed GFM with one table or placeholder per section", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const payload = shapeStats(stats)
        const md = renderMarkdown(payload)
        expect(md.endsWith("\n")).toBe(true)
        const [title, ...sections] = md.split("\n## ")
        expect(title.split("\n")).toEqual(["# opencode usage stats", "", expect.stringMatching(/^Generated `/), ""])
        expect(sections.map((section) => section.split("\n")[0])).toEqual([
          "Overview",
          "Tokens",
          "Model usage",
          "Tool usage",
        ])

        const rows = [6, 6, payload.models.length, payload.tools.length]
        const placeholders = ["", "", "_No model usage recorded._", "_No tool usage recorded._"]
        sections.forEach((section, i) => {
          const [, gap, ...body] = section.split("\n")
          expect(gap).toBe("")
          expect(body.at(-1)).toBe("")
          const lines = body.slice(0, -1)
          if (rows[i] === 0) return expect(lines).toEqual([placeholders[i]])

          const cells = (line: string) => line.slice(2, -2).split(/(?<!\\) \| /)
          const [header, separator, ...data] = lines
          expect(separator).toMatch(/^\| --- (\| ---: )*\|$/)
          expect(cells(separator).length).toBe(cells(header).length)
          expect(data.length).toBe(rows[i])
          for (const line of [header, ...data]) {
            expect(line).toMatch(/^\| .* \|$/)
            expect(cells(line).length).toBe(cells(header).length)
          }
          if (i >= 2) for (const line of data) expect(isCodeSpan(cells(line)[0])).toBe(true)
        })
      }),
    )
  })

  // Acceptance: no value has more than 4 decimal places or uses scientific
  // notation, and token counts are exact integers -- as written, not just
  // once a csv reader has unquoted them.
  test("R3 invariant: csv numbers are plain decimals with at most 4 places, token counts integers", () => {
    const INTEGER_METRICS = new Set([
      "days",
      "sessions",
      "messages",
      "input",
      "output",
      "reasoning",
      "cache_read",
      "cache_write",
      "total",
      "calls",
    ])
    fc.assert(
      fc.property(statsArb, (stats) => {
        const csv = renderCsv(shapeStats(stats))
        expect(csv.split("\n")[0]).toBe("scope,scope_id,metric,value")
        expect(csv.endsWith("\n")).toBe(true)
        for (const row of csvRows(csv)) {
          if (row.scope === "meta" && row.metric !== "days") continue
          expect(row.rawValue).toMatch(INTEGER_METRICS.has(row.metric) ? /^\d+$/ : /^-?\d+(\.\d{1,4})?$/)
        }
      }),
    )
  })

  test("R3 idempotent: re-exporting an exported csv reproduces it exactly", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const once = shapeStats(stats)
        const twice = shapeStats(statsFromPayload(once))
        expect(renderCsv(withoutClock(twice))).toBe(renderCsv(withoutClock(once)))
      }),
    )
  })
})

const format = fc.constantFrom("json", "csv", "md")
const segment = fc.stringMatching(/^[a-z0-9_-]{1,8}$/)

/** Parses an export file back into the format-neutral numbers. */
const parseExport = (fmt: string, body: string) =>
  fmt === "json" ? flatten(JSON.parse(body)) : fmt === "csv" ? fromCsv(body) : flatten(fromMarkdown(body))

/** Runs exports with stderr silenced, in a scratch dir that is removed afterwards. */
async function inScratch(run: (root: string, stderr: ReturnType<typeof spyOn>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "stats-export-prop-"))
  const err = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    await run(root, err)
  } finally {
    err.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}

describe("stats export location properties", () => {
  // Acceptance: reports go to a dedicated stats directory, which settings can
  // move elsewhere; --out overrides both for a single run.
  test("R4 invariant: exports land in --out, else the configured dir, and never the working directory", async () => {
    await fc.assert(
      fc.asyncProperty(
        format,
        fc.array(segment, { minLength: 1, maxLength: 3 }),
        fc.option(fc.array(segment, { minLength: 1, maxLength: 3 }), { nil: undefined }),
        async (fmt, configuredParts, outParts) => {
          await inScratch(async (root, stderr) => {
            const configured = join(root, "configured", ...configuredParts)
            const out = outParts && join(root, "out", ...outParts)
            const cwdBefore = await readdir(process.cwd())

            const path = await Effect.runPromise(exportStats(EXAMPLE, undefined, undefined, fmt, { out, configured }))

            expect(path).toBe(join(out ?? configured, `opencode_stats.${fmt}`))
            expect(await readdir(out ?? configured)).toEqual([`opencode_stats.${fmt}`])
            expect(await readdir(process.cwd())).toEqual(cwdBefore)
            // The file is in the requested format and says where it went.
            const body = await readFile(path, "utf8")
            expect(body.endsWith("\n")).toBe(true)
            expect(parseExport(fmt, body)).toEqual(flatten(shapeStats(EXAMPLE)))
            expect(stderr).toHaveBeenCalledWith(`Wrote ${path}\n`)
          })
        },
      ),
      { numRuns: 25 },
    )
  })

  // Acceptance: with nothing configured, the default is a stats folder of the
  // opencode app (its data dir), not the data dir itself.
  test("R4 default: without --out or stats_dir, exports go to a stats folder in opencode's data dir", () => {
    const dir = fc.option(fc.oneof(fc.constant(""), segment.map((name) => join(tmpdir(), name))), { nil: undefined })
    fc.assert(
      fc.property(dir, dir, (out, configured) => {
        const expected = out ? out : configured ? configured : join(Global.Path.data, "stats")
        expect(resolveExportDir(out, configured)).toBe(expected)
      }),
    )
  })

  // A read-only or blocked location is a user condition: it must surface as a
  // CliError naming the path, not a crash or a silent no-op.
  test("R4 errors: an export dir or file that cannot be written fails with a CliError naming it", async () => {
    await fc.assert(
      fc.asyncProperty(format, fc.array(segment, { minLength: 1, maxLength: 3 }), fc.boolean(), async (fmt, parts, blockDir) => {
        await inScratch(async (root) => {
          const configured = join(root, "configured", ...parts)
          let expected: string
          let out: string | undefined
          if (blockDir) {
            // A regular file where a parent directory should be.
            await writeFile(join(root, "file"), "")
            out = join(root, "file", ...parts)
            expected = `Could not create ${out}: `
          } else {
            // A directory where the export file should be.
            await mkdir(join(configured, `opencode_stats.${fmt}`), { recursive: true })
            expected = `Could not write ${join(configured, `opencode_stats.${fmt}`)}: `
          }
          const error = await Effect.runPromise(Effect.flip(exportStats(EXAMPLE, undefined, undefined, fmt, { out, configured })))
          expect(error).toBeInstanceOf(CliError)
          expect(error.message.startsWith(expected)).toBe(true)
        })
      }),
      { numRuns: 25 },
    )
  })

  // Revised acceptance: by default every export is a new timestamped file, so
  // earlier reports are kept; --overwrite replaces one fixed file instead. The
  // CLI passes Date.now() as the timestamp unless --overwrite is set.
  test("R5 idempotent: repeated exports keep every report, and --overwrite leaves one file with the latest stats", async () => {
    await fc.assert(
      fc.asyncProperty(format, fc.array(statsArb, { minLength: 1, maxLength: 4 }), async (fmt, runs) => {
        await inScratch(async (configured) => {
          for (const [i, stats] of runs.entries()) {
            await Effect.runPromise(exportStats(stats, undefined, undefined, fmt, { configured, timestamp: 1_000 + i }))
          }
          const timestamped = runs.map((_, i) => `opencode_stats_${1_000 + i}.${fmt}`)
          expect((await readdir(configured)).sort()).toEqual(timestamped.toSorted())

          for (const stats of runs) {
            await Effect.runPromise(exportStats(stats, undefined, undefined, fmt, { configured }))
          }
          expect((await readdir(configured)).sort()).toEqual([`opencode_stats.${fmt}`, ...timestamped].sort())
          if (fmt === "json") {
            const written = JSON.parse(await readFile(join(configured, "opencode_stats.json"), "utf8"))
            expect(withoutClock(written)).toEqual(withoutClock(shapeStats(runs.at(-1)!)))
          }
        })
      }),
      { numRuns: 25 },
    )
  })

  // Without --export the command is the terminal report: something is printed
  // and no file is written anywhere.
  test("R4 no export: without a format, stats prints to the terminal and writes no file", async () => {
    await fc.assert(
      fc.asyncProperty(statsArb, async (stats) => {
        await inScratch(async (root) => {
          const log = spyOn(console, "log").mockImplementation(() => {})
          try {
            await Effect.runPromise(reportStats(stats, undefined, undefined, undefined, join(root, "unused")))
            expect(log).toHaveBeenCalled()
          } finally {
            log.mockRestore()
          }
          expect(await readdir(root)).toEqual([])
        })
      }),
      { numRuns: 25 },
    )
  })
})
