import assert from "node:assert/strict";
import test from "node:test";
import {
  collectArtificialAnalysisModels,
  collectResetHistory,
  parseArtificialAnalysisModels,
  parseResetHistory,
} from "../src/collectors/external.mjs";
import { CodexInspector } from "../src/inspector.mjs";
import { buildResetCalendar } from "../src/reset-calendar.mjs";
import { childEnvironment, TtlCache } from "../src/utils.mjs";

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

const MODEL_FIXTURE = {
  id: "model-codex",
  name: "GPT-5.3 Codex (xhigh)",
  slug: "gpt-5-3-codex",
  model_creator: { id: "openai", name: "OpenAI" },
  evaluations: {
    artificial_analysis_coding_index: 71.2,
    artificial_analysis_intelligence_index: 68.4,
    artificial_analysis_agentic_index: 66.1,
  },
  artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 3.14 } },
  pricing: { price_1m_input_tokens: 2, price_1m_output_tokens: 8 },
  performance: {
    median_output_tokens_per_second: 94.2,
    median_time_to_first_token_seconds: 1.8,
    median_end_to_end_response_time_seconds: 48.5,
  },
};

test("reset history keeps string IDs, validates sources, and respects the requested window", () => {
  const from = "2026-07-21T00:00:00.000Z";
  const to = "2026-08-20T00:00:00.000Z";
  const result = parseResetHistory({
    data: [
      {
        id: "1956789012345678901",
        announced_at: "2026-08-10T12:00:00.000Z",
        text: "  Usage reset announced.\n",
        source: { url: "https://x.com/thsottiaux/status/1956789012345678901?tracking=1" },
      },
      {
        id: "1956789012345678900",
        announced_at: "2026-07-01T12:00:00.000Z",
        text: "outside window",
        source: { url: "https://example.com/private" },
      },
    ],
    pagination: { has_more: false },
  }, { from, to });

  assert.equal(result.count, 1);
  assert.equal(result.items[0].id, "1956789012345678901");
  assert.equal(result.items[0].text, "Usage reset announced.");
  assert.equal(result.items[0].sourceUrl, "https://x.com/thsottiaux/status/1956789012345678901");
});

test("reset calendar groups UTC announcement days into complete Monday-first weeks", () => {
  const calendar = buildResetCalendar({
    available: true,
    from: "2026-07-21T12:00:00.000Z",
    to: "2026-08-20T12:00:00.000Z",
    items: [
      { announcedAt: "2026-08-10T01:00:00.000Z" },
      { announcedAt: "2026-08-10T23:59:00.000Z" },
      { announcedAt: "2026-07-20T23:59:00.000Z" },
    ],
  });

  assert.equal(calendar.available, true);
  assert.equal(calendar.gridFrom, "2026-07-20");
  assert.equal(calendar.gridTo, "2026-08-23");
  assert.equal(calendar.days.length, 35);
  assert.equal(calendar.days.find((day) => day.date === "2026-08-10").count, 2);
  assert.equal(calendar.days.find((day) => day.date === "2026-07-20").inWindow, false);
});

test("reset calendar reports unavailable history without inventing dates", () => {
  assert.deepEqual(buildResetCalendar({ available: false, reason: "offline" }), {
    available: false,
    timezone: "UTC",
    weekStartsOn: "monday",
    from: null,
    to: null,
    gridFrom: null,
    gridTo: null,
    days: [],
    reason: "offline",
  });
});

test("external text strips Unicode direction controls", () => {
  const reset = parseResetHistory({
    data: [{
      id: "1956789012345678901",
      announced_at: "2026-08-10T12:00:00.000Z",
      text: "Reset \u202ereversed\u2066 label",
      source: { url: "https://x.com/thsottiaux/status/1956789012345678901" },
    }],
  }, { from: "2026-08-01T00:00:00Z", to: "2026-08-20T00:00:00Z" });
  const models = parseArtificialAnalysisModels({
    data: [{ ...MODEL_FIXTURE, name: "GPT-5.3 \u202eCodex\u2069 (high)" }],
  });

  assert.equal(reset.items[0].text, "Reset reversed label");
  assert.equal(models.models[0].name, "GPT-5.3 Codex (high)");
  assert.doesNotMatch(JSON.stringify({ reset, models }), /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
});

test("reset collector sends a bounded 30-day query to the fixed provider", async () => {
  let observedUrl;
  const fetchImpl = async (url, options) => {
    observedUrl = new URL(url);
    assert.equal(options.method, "GET");
    assert.equal(options.headers.Accept, "application/json");
    assert.equal(options.headers["x-api-key"], undefined);
    return jsonResponse({ data: [], pagination: { has_more: false, next_cursor: null }, meta: { generated_at: "2026-08-20T00:00:00Z" } });
  };

  await collectResetHistory({ fetchImpl, now: Date.parse("2026-08-20T00:00:00Z") });
  assert.equal(observedUrl.origin, "https://codex-resets.com");
  assert.equal(observedUrl.pathname, "/api/v1/resets");
  assert.equal(observedUrl.searchParams.get("limit"), "100");
  assert.equal(observedUrl.searchParams.get("order"), "desc");
  assert.equal(observedUrl.searchParams.get("from"), "2026-07-21T00:00:00.000Z");
});

test("reset collector follows opaque cursors while preserving the original range", async () => {
  const observed = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    observed.push(parsed);
    const secondPage = parsed.searchParams.has("cursor");
    return jsonResponse({
      data: [{
        id: secondPage ? "2000000000000000002" : "2000000000000000001",
        announced_at: secondPage ? "2026-08-02T00:00:00Z" : "2026-08-10T00:00:00Z",
        text: secondPage ? "second" : "first",
        source: { url: `https://x.com/thsottiaux/status/${secondPage ? "2000000000000000002" : "2000000000000000001"}` },
      }],
      pagination: { has_more: !secondPage, next_cursor: secondPage ? null : "opaque_cursor" },
      meta: {},
    });
  };
  const result = await collectResetHistory({ fetchImpl, now: Date.parse("2026-08-20T00:00:00Z") });
  assert.equal(observed.length, 2);
  assert.equal(observed[1].searchParams.get("cursor"), "opaque_cursor");
  for (const url of observed) {
    assert.equal(url.searchParams.get("from"), "2026-07-21T00:00:00.000Z");
    assert.equal(url.searchParams.get("to"), "2026-08-20T00:00:00.000Z");
    assert.equal(url.searchParams.get("order"), "desc");
  }
  assert.equal(result.items.length, 2);
  assert.equal(result.limited, false);
});

test("reset collector bounds aggregate response bytes and item count", async () => {
  const resetItem = (index) => ({
    id: (2_000_000_000_000_000_000n + BigInt(index)).toString(),
    announced_at: "2026-08-10T00:00:00Z",
    text: `reset ${index}`,
    source: { url: `https://x.com/thsottiaux/status/${2_000_000_000_000_000_000n + BigInt(index)}` },
  });
  const itemLimited = await collectResetHistory({
    now: Date.parse("2026-08-20T00:00:00Z"),
    fetchImpl: async () => jsonResponse({
      data: Array.from({ length: 501 }, (_value, index) => resetItem(index)),
      pagination: { has_more: false, next_cursor: null },
    }),
  });
  assert.equal(itemLimited.items.length, 500);
  assert.equal(itemLimited.limited, true);

  let calls = 0;
  const byteLimited = await collectResetHistory({
    now: Date.parse("2026-08-20T00:00:00Z"),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({
        data: [resetItem(calls)],
        pagination: { has_more: true, next_cursor: `page_${calls + 1}` },
        padding: "x".repeat(3 * 1024 * 1024),
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(byteLimited.items.length, 1);
  assert.equal(byteLimited.limited, true);
});

test("Artificial Analysis parser exposes only benchmarked OpenAI Codex metrics", () => {
  const codexFamilies = [
    MODEL_FIXTURE,
    { ...MODEL_FIXTURE, id: "sol", name: "GPT-5.6 Sol (high)", slug: "gpt-5-6-sol-high", evaluations: { artificial_analysis_coding_index: 70 } },
    { ...MODEL_FIXTURE, id: "terra", name: "GPT-5.6 Terra (max)", slug: "gpt-5-6-terra-max", evaluations: { artificial_analysis_coding_index: 69 } },
    { ...MODEL_FIXTURE, id: "luna", name: "GPT-5.6 Luna (xhigh)", slug: "gpt-5-6-luna-xhigh", evaluations: { artificial_analysis_coding_index: 68 } },
  ];
  const result = parseArtificialAnalysisModels({
    intelligence_index_version: 4.1,
    data: [
      ...codexFamilies,
      { ...MODEL_FIXTURE, id: "other", name: "Claude", slug: "claude", model_creator: { name: "Anthropic" } },
      { ...MODEL_FIXTURE, id: "plain-openai", name: "GPT-5.4", slug: "gpt-5-4" },
    ],
  });

  assert.equal(result.count, 4);
  assert.equal(result.intelligenceIndexVersion, 4.1);
  assert.deepEqual(new Set(result.models.map((model) => model.id)), new Set(["model-codex", "sol", "terra", "luna"]));
  assert.deepEqual(result.models[0], {
    id: "model-codex",
    name: "GPT-5.3 Codex (xhigh)",
    slug: "gpt-5-3-codex",
    codingIndex: 71.2,
    intelligenceIndex: 68.4,
    agenticIndex: 66.1,
    costPerTask: 3.14,
    blendedPricePerMillion: null,
    inputPricePerMillion: 2,
    outputPricePerMillion: 8,
    outputTokensPerSecond: 94.2,
    timeToFirstTokenSeconds: 1.8,
    endToEndSeconds: 48.5,
  });
});

test("Artificial Analysis stays disabled without a key and uses the current free endpoint with one", async () => {
  let calls = 0;
  const disabled = await collectArtificialAnalysisModels({ fetchImpl: async () => { calls += 1; } });
  assert.equal(disabled.configured, false);
  assert.equal(calls, 0);

  const enabled = await collectArtificialAnalysisModels({
    apiKey: "test-secret",
    fetchImpl: async (url, options) => {
      calls += 1;
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://artificialanalysis.ai");
      assert.equal(parsed.pathname, "/api/v2/language/models/free");
      assert.equal(parsed.searchParams.get("page"), "1");
      assert.equal(options.headers["x-api-key"], "test-secret");
      return jsonResponse({
        intelligence_index_version: 4.1,
        pagination: { has_more: false },
        data: [MODEL_FIXTURE],
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(enabled.models.length, 1);
  assert.doesNotMatch(JSON.stringify(enabled), /test-secret/);
});

test("Artificial Analysis follows page numbers, bounds the catalog, and honors rate-limit delay", async () => {
  const pages = [];
  const paged = await collectArtificialAnalysisModels({
    apiKey: "test-key",
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      return jsonResponse({
        pagination: { has_more: page === 1 },
        data: [{ ...MODEL_FIXTURE, id: `page-${page}`, name: `GPT-5.6 ${page === 1 ? "Sol" : "Terra"} (high)`, slug: `codex-page-${page}` }],
      });
    },
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(paged.models.length, 2);
  assert.equal(paged.limited, false);

  let capCalls = 0;
  const capped = await collectArtificialAnalysisModels({
    apiKey: "test-key",
    fetchImpl: async () => {
      capCalls += 1;
      return jsonResponse({
        pagination: { has_more: true },
        data: [{ ...MODEL_FIXTURE, id: `cap-${capCalls}` }],
      });
    },
  });
  assert.equal(capCalls, 5);
  assert.equal(capped.limited, true);

  let itemCalls = 0;
  const itemCapped = await collectArtificialAnalysisModels({
    apiKey: "test-key",
    fetchImpl: async () => {
      itemCalls += 1;
      return jsonResponse({
        pagination: { has_more: true },
        data: Array.from({ length: 750 }, (_value, index) => ({
          ...MODEL_FIXTURE,
          id: `catalog-${itemCalls}-${index}`,
          name: `Codex catalog ${itemCalls}-${index}`,
        })),
      });
    },
  });
  assert.equal(itemCalls, 2);
  assert.equal(itemCapped.count, 1_000);
  assert.equal(itemCapped.limited, true);

  await assert.rejects(
    () => collectArtificialAnalysisModels({
      apiKey: "test-key",
      fetchImpl: async () => new Response("", {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "120" },
      }),
    }),
    (error) => error.message === "The remote API rate limit was reached." && error.retryAfterMs === 120_000,
  );
});

test("model display cap is explicit", () => {
  const data = Array.from({ length: 31 }, (_value, index) => ({
    ...MODEL_FIXTURE,
    id: `codex-${index}`,
    name: `Codex model ${index}`,
    slug: `codex-model-${index}`,
  }));
  const result = parseArtificialAnalysisModels({ data });
  assert.equal(result.count, 31);
  assert.equal(result.displayedCount, 30);
  assert.equal(result.models.length, 30);
  assert.equal(result.limited, true);
});

test("insights requests are single-flight and child processes do not inherit the API key", async () => {
  const counts = { resets: 0, models: 0 };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "codex-resets.com") {
      counts.resets += 1;
      return jsonResponse({ data: [], pagination: { has_more: false, next_cursor: null }, meta: {} });
    }
    counts.models += 1;
    return jsonResponse({ pagination: { has_more: false }, data: [MODEL_FIXTURE] });
  };
  const inspector = new CodexInspector({
    codexHome: "/tmp/xedoc-test",
    fetchImpl,
    artificialAnalysisApiKey: "never-in-a-child",
  });
  const [left, right] = await Promise.all([inspector.insights(), inspector.insights()]);
  assert.equal(counts.resets, 1);
  assert.equal(counts.models, 1);
  assert.deepEqual(left.resets, right.resets);
  assert.deepEqual(left.models, right.models);

  const environment = childEnvironment({
    ARTIFICIAL_ANALYSIS_API_KEY: "never-in-a-child",
    Artificial_Analysis_Api_Key: "also-never-in-a-child",
    PATH: "/bin",
  });
  assert.equal(environment.ARTIFICIAL_ANALYSIS_API_KEY, undefined);
  assert.equal(environment.Artificial_Analysis_Api_Key, undefined);
  assert.equal(environment.PATH, "/bin");
});

test("reset-only inspection does not request model benchmark data", async () => {
  const hosts = [];
  const inspector = new CodexInspector({
    codexHome: "/tmp/xedoc-reset-only-test",
    artificialAnalysisApiKey: "not-needed-for-resets",
    fetchImpl: async (url) => {
      hosts.push(new URL(url).hostname);
      return jsonResponse({ data: [], pagination: { has_more: false, next_cursor: null }, meta: {} });
    },
  });

  const resets = await inspector.resetHistory();
  assert.deepEqual(hosts, ["codex-resets.com"]);
  assert.equal(resets.available, true);
  assert.equal(resets.calendar.available, true);
});

test("provider failures are negatively cached and an expired success can be served stale", async () => {
  let failedCalls = 0;
  const failedInspector = new CodexInspector({
    codexHome: "/tmp/xedoc-failed-test",
    artificialAnalysisApiKey: "test-key",
    fetchImpl: async () => {
      failedCalls += 1;
      throw new TypeError("offline");
    },
  });
  const first = await failedInspector.insights();
  const second = await failedInspector.insights();
  assert.equal(failedCalls, 2);
  assert.equal(first.resets.available, false);
  assert.deepEqual(first.resets, second.resets);

  const cache = new TtlCache(0);
  const successful = { available: true, fetchedAt: 123 };
  assert.equal(await cache.get(async () => successful), successful);
  const stale = await cache.get(async () => { throw new Error("temporary failure"); }, {
    staleIfError: true,
    errorTtlMs: 60_000,
  });
  assert.equal(stale, successful);
});
