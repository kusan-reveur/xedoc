import assert from "node:assert/strict";
import test from "node:test";
import { collectResetHistory, parseResetHistory } from "../src/collectors/external.mjs";
import { CodexInspector } from "../src/inspector.mjs";
import { buildResetCalendar } from "../src/reset-calendar.mjs";
import { TtlCache } from "../src/utils.mjs";

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

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

  assert.equal(reset.items[0].text, "Reset reversed label");
  assert.doesNotMatch(JSON.stringify(reset), /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
});

test("reset collector sends a bounded 30-day query to the fixed public provider", async () => {
  let observedUrl;
  const fetchImpl = async (url, options) => {
    observedUrl = new URL(url);
    assert.equal(options.method, "GET");
    assert.deepEqual(options.headers, { Accept: "application/json" });
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

test("insights make one public reset request and no model-data network request", async () => {
  const hosts = [];
  const inspector = new CodexInspector({
    codexHome: "/tmp/xedoc-keyless-insights-test",
    fetchImpl: async (url) => {
      hosts.push(new URL(url).hostname);
      return jsonResponse({ data: [], pagination: { has_more: false, next_cursor: null }, meta: {} });
    },
  });

  const [left, right] = await Promise.all([inspector.insights(), inspector.insights()]);
  assert.deepEqual(hosts, ["codex-resets.com"]);
  assert.deepEqual(left.resets, right.resets);
  assert.equal(left.modelProfiles.available, false);
  assert.equal(left.network.policy.includes("computed locally"), true);
});

test("provider failures are negatively cached and an expired success can be served stale", async () => {
  let failedCalls = 0;
  const failedInspector = new CodexInspector({
    codexHome: "/tmp/xedoc-failed-test",
    fetchImpl: async () => {
      failedCalls += 1;
      throw new TypeError("offline");
    },
  });
  const first = await failedInspector.insights();
  const second = await failedInspector.insights();
  assert.equal(failedCalls, 1);
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
