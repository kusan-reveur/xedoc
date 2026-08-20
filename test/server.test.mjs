import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createXedocServer, listen } from "../src/server.mjs";

test("HTTP server keeps its token out of static responses and protects metadata APIs", async (context) => {
  const token = "a".repeat(64);
  const inspector = {
    snapshot: async () => ({ generatedAt: 1, privacy: { localOnly: true } }),
    threads: async () => ({ data: [], total: 0 }),
    activity: async (threadId) => ({ available: true, threadId, events: [] }),
    insights: async () => ({ generatedAt: 2, resets: { items: [] }, models: { models: [] } }),
    resetHistory: async () => ({ available: true, calendar: { days: [] } }),
    files: async () => ({ data: [], total: 0 }),
  };
  const { server } = createXedocServer({ inspector, token });
  let address;
  try {
    address = await listen(server, { host: "127.0.0.1", port: 0 });
  } catch (error) {
    if (error.code === "EPERM") {
      context.skip("Loopback sockets are blocked by this test sandbox.");
      return;
    }
    throw error;
  }
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const root = await fetch(address.url);
  assert.equal(root.status, 200);
  assert.doesNotMatch(await root.text(), new RegExp(token));
  assert.equal(root.headers.get("x-frame-options"), "DENY");
  assert.match(root.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal(root.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(root.headers.get("cache-control"), "no-store");

  const unauthorized = await fetch(`${address.url}api/snapshot`);
  assert.equal(unauthorized.status, 401);
  const unauthorizedActivity = await fetch(`${address.url}api/activity?threadId=thread-1`);
  assert.equal(unauthorizedActivity.status, 401);
  const unauthorizedInsights = await fetch(`${address.url}api/insights`);
  assert.equal(unauthorizedInsights.status, 401);
  const unauthorizedResets = await fetch(`${address.url}api/resets`);
  assert.equal(unauthorizedResets.status, 401);

  const authorized = await fetch(`${address.url}api/snapshot`, {
    headers: { "X-Xedoc-Token": token },
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { generatedAt: 1, privacy: { localOnly: true } });

  const activity = await fetch(`${address.url}api/activity?threadId=thread-1`, {
    headers: { "X-Xedoc-Token": token },
  });
  assert.equal(activity.status, 200);
  assert.equal((await activity.json()).threadId, "thread-1");

  const insights = await fetch(`${address.url}api/insights`, {
    headers: { "X-Xedoc-Token": token },
  });
  assert.equal(insights.status, 200);
  assert.equal((await insights.json()).generatedAt, 2);

  const resets = await fetch(`${address.url}api/resets`, {
    headers: { "X-Xedoc-Token": token },
  });
  assert.equal(resets.status, 200);
  assert.equal((await resets.json()).resets.available, true);

  const crossOrigin = await fetch(`${address.url}api/snapshot`, {
    headers: { "X-Xedoc-Token": token, Origin: "https://example.com" },
  });
  assert.equal(crossOrigin.status, 403);

  const hostileStatus = await new Promise((resolve, reject) => {
    const request = http.get(address.url, { headers: { Host: "example.com" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("error", reject);
  });
  assert.equal(hostileStatus, 421);
});

test("listen refuses a non-loopback bind even for a loopback-configured server", async () => {
  const inspector = {
    snapshot: async () => ({}),
    threads: async () => ({ data: [], total: 0 }),
    activity: async () => ({ available: false }),
    insights: async () => ({}),
    resetHistory: async () => ({ available: false }),
    files: async () => ({ data: [], total: 0 }),
  };
  const { server } = createXedocServer({ inspector });
  await assert.rejects(() => listen(server, { host: "0.0.0.0", port: 0 }), /loopback/);
});
