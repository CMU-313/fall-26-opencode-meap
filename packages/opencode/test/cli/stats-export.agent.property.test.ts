import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { renderCsv, shapeStats, type SessionStats } from "../../src/cli/cmd/stats"

const tokens = fc.nat({ max: 1_000_000_000_000 })
const amount = fc.double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true })

const statsArb: fc.Arbitrary<SessionStats> = fc.record({
  totalSessions: fc.nat({ max: 100_000 }),
  totalMessages: fc.nat({ max: 10_000_000 }),
  totalCost: amount,
  totalTokens: fc.record({
    input: tokens,
    output: tokens,
    reasoning: tokens,
    cache: fc.record({ read: tokens, write: tokens }),
  }),
  toolUsage: fc.dictionary(fc.stringMatching(/^[a-z]{1,12}$/), fc.nat({ max: 1_000_000 }), { maxKeys: 6 }),
  modelUsage: fc.dictionary(
    fc.stringMatching(/^[a-z]{1,8}\/[a-z]{1,8}$/),
    fc.record({
      messages: fc.nat({ max: 100_000 }),
      tokens: fc.record({ input: tokens, output: tokens, cache: fc.record({ read: tokens, write: tokens }) }),
      cost: amount,
    }),
    { maxKeys: 6 },
  ),
  dateRange: fc.record({ earliest: fc.constant(0), latest: fc.constant(0) }),
  days: fc.nat({ max: 3_650 }),
  costPerDay: amount,
  tokensPerSession: amount,
  medianTokensPerSession: amount,
})

describe("stats csv export R3", () => {
  test("writes generated numeric values as plain decimals with at most four decimal places", () => {
    fc.assert(
      fc.property(statsArb, (stats) => {
        const csv = renderCsv(shapeStats(stats))
        const rows = csv.trim().split("\n").slice(1).map((row) => row.split(","))
        const integerMetrics = new Set([
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

        for (const [scope, , metric, value] of rows) {
          if (scope === "meta" && metric !== "days") continue
          expect(value).toMatch(integerMetrics.has(metric) ? /^\d+$/ : /^\d+(?:\.\d{1,4})?$/)
        }
      }),
      { numRuns: 200 },
    )
  })

  // Strengthened: the aggregator emits NaN averages for empty data, so the
  // generator has to reach them; and every metric must be written, with the
  // value it came from, so an empty or all-zero csv cannot pass.
  const average = fc.oneof(amount, fc.constantFrom(NaN, Infinity))
  const edgeStatsArb = fc
    .tuple(statsArb, average, average, average)
    .map(([stats, costPerDay, tokensPerSession, medianTokensPerSession]) => ({
      ...stats,
      costPerDay,
      tokensPerSession,
      medianTokensPerSession,
    }))

  test("strengthened: every metric is a plain decimal matching the stats it came from, even for NaN averages", () => {
    fc.assert(
      fc.property(edgeStatsArb, (stats) => {
        const csv = renderCsv(shapeStats(stats))
        expect(csv.startsWith("scope,scope_id,metric,value\n")).toBe(true)
        expect(csv.endsWith("\n")).toBe(true)
        const rows = csv.trim().split("\n").slice(1).map((row) => row.split(","))
        // Keep opencode's check that every row, not only the ones listed below, is a plain number.
        const integerMetrics = ["days", "sessions", "messages", "input", "output", "reasoning", "cache_read", "cache_write", "total", "calls"]
        for (const [scope, , metric, value] of rows) {
          if (scope === "meta" && metric !== "days") continue
          expect(value).toMatch(integerMetrics.includes(metric) ? /^\d+$/ : /^\d+(?:\.\d{1,4})?$/)
        }
        const cell = (scope: string, id: string, metric: string) =>
          rows.find((row) => row[0] === scope && row[1] === id && row[2] === metric)?.[3]
        const exact: [string, string, string, number][] = [
          ["overview", "", "sessions", stats.totalSessions],
          ["overview", "", "messages", stats.totalMessages],
          ["tokens", "", "input", stats.totalTokens.input],
          ["tokens", "", "output", stats.totalTokens.output],
          ["tokens", "", "reasoning", stats.totalTokens.reasoning],
          ["tokens", "", "cache_read", stats.totalTokens.cache.read],
          ["tokens", "", "cache_write", stats.totalTokens.cache.write],
          ...Object.entries(stats.modelUsage).map(([id, usage]): [string, string, string, number] => ["model", id, "messages", usage.messages]),
          ...Object.entries(stats.toolUsage).map(([name, calls]): [string, string, string, number] => ["tool", name, "calls", calls]),
        ]
        const rounded: [string, string, string, number][] = [
          ["overview", "", "cost_usd", stats.totalCost],
          ["overview", "", "cost_per_day_usd", stats.costPerDay],
          ["overview", "", "tokens_per_session", stats.tokensPerSession],
          ["overview", "", "median_tokens_per_session", stats.medianTokensPerSession],
          ...Object.entries(stats.modelUsage).map(([id, usage]): [string, string, string, number] => ["model", id, "cost_usd", usage.cost]),
        ]
        for (const [scope, id, metric, source] of exact) expect(cell(scope, id, metric)).toBe(String(source))
        for (const [scope, id, metric, source] of rounded) {
          const written = cell(scope, id, metric)
          expect(written).toMatch(/^\d+(?:\.\d{1,4})?$/)
          // 4-place rounding is off by at most 0.00005; non-finite averages are written as 0.
          expect(Math.abs(Number(written) - (Number.isFinite(source) ? source : 0))).toBeLessThanOrEqual(5.1e-5)
        }
      }),
      { numRuns: 200 },
    )
  })
})
