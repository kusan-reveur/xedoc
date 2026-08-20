import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchDashboard, openBrowser } from "../src/browser-launcher.mjs";
import { parseArgs } from "../src/config.mjs";
import { collectRecentActivity } from "../src/collectors/activity.mjs";
import {
  collectLargestRollouts,
  collectSessionIndexNames,
  groupLargestRollouts,
  listDirectory,
} from "../src/collectors/storage.mjs";
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

test("session-index task names are bounded, normalized, and selected by thread ID", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-session-index-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "session_index.jsonl"), [
    JSON.stringify({ id: "thread-a", thread_name: "Old name", updated_at: "2026-08-19T00:00:00Z" }),
    JSON.stringify({ id: "thread-b", thread_name: "x".repeat(180), updated_at: "2026-08-20T00:00:00Z" }),
    JSON.stringify({ id: "thread-a", thread_name: "  Useful\u202e task\nname  ", updated_at: "2026-08-20T00:00:00Z" }),
  ].join("\n"));

  const names = await collectSessionIndexNames(root, ["thread-a", "thread-b", "missing"]);
  assert.equal(names.get("thread-a"), "Useful task name");
  assert.equal(names.get("thread-b").length, 120);
  assert.match(names.get("thread-b"), /…$/u);
  assert.equal(names.has("missing"), false);
  assert.doesNotMatch(JSON.stringify([...names]), /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);

  await fs.writeFile(path.join(root, "session_index.jsonl"), [
    JSON.stringify({ id: "outside-tail", thread_name: "Must not be scanned" }),
    "\n".repeat(25_000),
    JSON.stringify({ id: "thread-a", thread_name: "Newest bounded name" }),
  ].join("\n"));
  const denseNames = await collectSessionIndexNames(root, ["outside-tail", "thread-a"]);
  assert.equal(denseNames.has("outside-tail"), false);
  assert.equal(denseNames.get("thread-a"), "Newest bounded name");
});

test("session-index task names reject internal and escaping symlinks", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-session-link-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "xedoc-session-link-outside-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  context.after(() => fs.rm(outside, { recursive: true, force: true }));
  const record = `${JSON.stringify({ id: "thread-a", thread_name: "Must stay hidden" })}\n`;
  await fs.writeFile(path.join(root, "real-index.jsonl"), record);
  await fs.symlink(path.join(root, "real-index.jsonl"), path.join(root, "session_index.jsonl"));
  assert.equal((await collectSessionIndexNames(root, ["thread-a"])).size, 0);

  await fs.unlink(path.join(root, "session_index.jsonl"));
  await fs.writeFile(path.join(outside, "outside-index.jsonl"), record);
  await fs.symlink(path.join(outside, "outside-index.jsonl"), path.join(root, "session_index.jsonl"));
  assert.equal((await collectSessionIndexNames(root, ["thread-a"])).size, 0);
});

test("rollout sizes are grouped under their archiveable parent task", () => {
  const candidates = [
    { id: "root", cwd: "/tmp/project", archived: false, parentThreadId: null },
    { id: "child-a", cwd: "/tmp/project", archived: false, parentThreadId: "root" },
    { id: "child-b", cwd: "/tmp/project", archived: true, parentThreadId: "child-a" },
    { id: "unlinked", cwd: "/tmp/project", archived: false, parentThreadId: null, isSubagent: true, agentNickname: "helper\u202e" },
    { id: "other", cwd: "/tmp/other", archived: true, parentThreadId: null },
  ];
  const rollouts = [
    { threadId: "root", path: "sessions/root.jsonl", bytes: 10, allocatedBytes: 512, modifiedAt: 10, archived: false },
    { threadId: "child-a", path: "sessions/child-a.jsonl", bytes: 40, allocatedBytes: 512, modifiedAt: 40, archived: false },
    { threadId: "child-b", path: "sessions/child-b.jsonl", bytes: 20, allocatedBytes: 512, modifiedAt: 20, archived: true },
    { threadId: "unlinked", path: "sessions/unlinked.jsonl", bytes: 35, allocatedBytes: 512, modifiedAt: 35, archived: false },
    { threadId: "other", path: "sessions/other.jsonl", bytes: 30, allocatedBytes: null, modifiedAt: 30, archived: true },
  ];
  rollouts.scanLimited = true;

  const groups = groupLargestRollouts(rollouts, candidates);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0], {
    threadId: "root",
    taskName: null,
    unlinkedSubagent: false,
    agentNickname: null,
    cwd: "/tmp/project",
    archived: false,
    rolloutCount: 3,
    bytes: 70,
    allocatedBytes: 1_536,
    modifiedAt: 40,
    largestRolloutPath: "sessions/child-a.jsonl",
  });
  assert.equal(groups[1].threadId, "unlinked");
  assert.equal(groups[1].unlinkedSubagent, true);
  assert.equal(groups[1].agentNickname, "helper");
  assert.equal(groups[2].threadId, "other");
  assert.equal(groups[2].allocatedBytes, null);
  assert.equal(groups.scanLimited, true);
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
