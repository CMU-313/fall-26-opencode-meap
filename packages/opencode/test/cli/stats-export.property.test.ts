import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import fc from "fast-check"
import { exportStats, renderCsv, renderMarkdown, shapeStats, type SessionStats } from "../../src/cli/cmd/stats"

fc.configureGlobal({ seed: 42 })

type Payload = ReturnType<typeof shapeStats>

const nat = (max: number) => fc.nat({ max })
const real = (max: number) => fc.double({ min: 0, max, noNaN: true, noDefaultInfinity: true })

const nanOr = (arb: fc.Arbitrary<number>) => fc.oneof(arb, fc.constant(NaN))
const tokens = nat(1e12)
const cache = fc.record({ read: tokens, write: tokens })
const usd = real(100_000)
const timestamp = fc.integer({ min: 1.6e12, max: 1.9e12 })

const statsArb: fc.Arbitrary<SessionStats> = fc.record({
  totalSessions: nat(100_000),
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
      const [scope, id, metric, value] = [...line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)].map(([, field]) =>
        field.startsWith('"') ? field.slice(1, -1).replaceAll('""', '"') : field,
      )
      return { scope, id, metric, value }
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
  const id = (cell: string) => (cell.startsWith("`` ") ? cell.slice(3, -3) : cell.slice(1, -1)).replaceAll("\\|", "|")
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

  test("R1 invariant: per-model rows are exactly the models used, ordered by message count", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const rows = shapeStats(stats).models
        expect(rows.map((row) => row.id).sort()).toEqual(Object.keys(stats.modelUsage).sort())
        for (const row of rows) expect(row.messages).toBe(stats.modelUsage[row.id].messages)
        for (let i = 1; i < rows.length; i++) expect(rows[i - 1].messages).toBeGreaterThanOrEqual(rows[i].messages)
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

  // Acceptance: no value has more than 4 decimal places or uses scientific
  // notation, and token counts are exact integers.
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
        for (const row of csvRows(renderCsv(shapeStats(stats)))) {
          if (row.scope === "meta" && row.metric !== "days") continue
          expect(row.value).toMatch(INTEGER_METRICS.has(row.metric) ? /^\d+$/ : /^-?\d+(\.\d{1,4})?$/)
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

/** Runs exports with stderr silenced, in a scratch dir that is removed afterwards. */
async function inScratch(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "stats-export-prop-"))
  const err = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    await run(root)
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
          await inScratch(async (root) => {
            const configured = join(root, "configured", ...configuredParts)
            const out = outParts && join(root, "out", ...outParts)
            const cwdBefore = await readdir(process.cwd())

            const path = await Effect.runPromise(exportStats(EXAMPLE, undefined, undefined, fmt, { out, configured }))

            expect(path).toBe(join(out ?? configured, `opencode_stats.${fmt}`))
            expect(await readdir(out ?? configured)).toEqual([`opencode_stats.${fmt}`])
            expect(await readdir(process.cwd())).toEqual(cwdBefore)
          })
        },
      ),
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
})
