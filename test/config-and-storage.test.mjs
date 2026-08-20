import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchDashboard, openBrowser } from "../src/browser-launcher.mjs";
import { parseArgs } from "../src/config.mjs";
import { collectRecentActivity } from "../src/collectors/activity.mjs";
import { collectLargestRollouts, listDirectory } from "../src/collectors/storage.mjs";
import { canonicalPathsOverlap, resolveSafeChild } from "../src/utils.mjs";

test("configuration refuses non-loopback hosts", () => {
  assert.throws(() => parseArgs(["--host", "0.0.0.0"]), /local-only/);
  assert.equal(parseArgs(["--host", "::1", "--port", "0"]).host, "::1");
  assert.equal(parseArgs(["--host", "localhost"]).host, "127.0.0.1");
});

test("launch opens the dashboard by default and supports an explicit no-open mode", () => {
  assert.equal(parseArgs([]).open, true);
  assert.equal(parseArgs(["--no-open"]).open, false);
  assert.equal(parseArgs(["--no-open", "--open"]).open, true);

  const launched = [];
  assert.equal(launchDashboard("http://127.0.0.1/#token=test", {
    open: parseArgs([]).open,
    openImpl: (url) => launched.push(url),
  }), true);
  assert.equal(launchDashboard("http://127.0.0.1/#token=test", {
    open: parseArgs(["--no-open"]).open,
    openImpl: (url) => launched.push(url),
  }), false);
  assert.deepEqual(launched, ["http://127.0.0.1/#token=test"]);
});

test("browser launcher passes the full URL without inheriting provider credentials", () => {
  let invocation;
  const child = { once() {}, unref() {} };
  openBrowser("http://127.0.0.1/#token=fragment", {
    platform: "linux",
    sourceEnvironment: { PATH: "/bin", Artificial_Analysis_Api_Key: "secret" },
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    },
  });
  assert.equal(invocation.command, "xdg-open");
  assert.deepEqual(invocation.args, ["http://127.0.0.1/#token=fragment"]);
  assert.equal(invocation.options.env.PATH, "/bin");
  assert.equal(invocation.options.env.Artificial_Analysis_Api_Key, undefined);
});

test("file browser stays inside CODEX_HOME and marks sensitive metadata", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-files-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "sessions"));
  await fs.writeFile(path.join(root, "sessions", "rollout.jsonl"), "{}\n");
  await fs.writeFile(path.join(root, "auth.json"), "not-read-by-the-test");

  const listing = await listDirectory(root);
  assert.equal(listing.total, 2);
  const auth = listing.data.find((item) => item.name === "auth.json");
  assert.equal(auth.sensitive, true);
  assert.equal(auth.bytes, 20);
  await assert.rejects(() => resolveSafeChild(root, "../outside"), /escapes/);
});

test("file browser refuses symlink traversal", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-link-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-outside-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, "escape"));
  await assert.rejects(() => resolveSafeChild(root, "escape"), /Symbolic links/);
});

test("rollout readers reject an ancestor symlink that resolves outside CODEX_HOME", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-rollout-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-rollout-outside-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  const outsideRollout = path.join(outside, "rollout.jsonl");
  await fs.writeFile(outsideRollout, `${JSON.stringify({
    timestamp: "2026-08-20T12:00:00.000Z",
    type: "session_meta",
    payload: { id: "outside-thread" },
  })}\n`);
  await fs.symlink(outside, path.join(root, "sessions"));
  const linkedRollout = path.join(root, "sessions", "rollout.jsonl");

  const activity = await collectRecentActivity({ codexHome: root, rolloutPath: linkedRollout });
  assert.equal(activity.available, false);
  assert.doesNotMatch(JSON.stringify(activity), /outside-thread/);
  const largest = await collectLargestRollouts([
    { id: "outside-thread", rolloutPath: linkedRollout, archived: false },
  ], root);
  assert.equal(largest.length, 0);
});

test("canonical overlap detection catches a symlinked directory alias", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-overlap-"));
  const alias = `${root}-alias`;
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  context.after(() => fs.rm(alias, { force: true }));
  await fs.symlink(root, alias);
  assert.equal(await canonicalPathsOverlap(root, alias), true);
});
