import assert from "node:assert/strict";
import test from "node:test";
import { collectOpenFiles, parsePsOutput, selectCodexProcessTree } from "../src/collectors/processes.mjs";

test("process parser selects Codex roots and their descendants without exposing argv", () => {
  const output = [
    "  100     1  501  1.5  2048 01:02 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    "  101   100  501  0.5  1024 00:59 /bin/zsh",
    "  102   101  501  5.0  4096 00:20 /usr/bin/git",
    "  200     1  501 20.0  8192 10:00 /Applications/Other.app/Contents/MacOS/Other",
    "  300     1  502  9.0  4096 00:30 /usr/local/bin/codex",
  ].join("\n");
  const parsed = parsePsOutput(output);
  const selected = selectCodexProcessTree(parsed, { uid: 501 });
  assert.deepEqual(selected.map((item) => item.pid), [100, 101, 102]);
  assert.equal(selected[0].role, "host");
  assert.equal(selected[0].group, "host");
  assert.equal(selected[1].role, "spawned");
  assert.equal(selected[0].rssBytes, 2_048 * 1_024);
  assert.equal(selected[0].elapsedSec, 62);
});

test("process grouping separates the main app, embedded worker, and its children", () => {
  const parsed = parsePsOutput([
    "  400     1  501  1.0  1000 01:00 /Applications/Codex.app/Contents/MacOS/Codex",
    "  401   400  501  2.0  2000 00:50 /Applications/Codex.app/Contents/Resources/codex",
    "  402   401  501  3.0  3000 00:40 /bin/zsh",
  ].join("\n"));
  const selected = selectCodexProcessTree(parsed, { uid: 501 });
  assert.deepEqual(selected.map(({ pid, role, group }) => ({ pid, role, group })), [
    { pid: 400, role: "host", group: "host" },
    { pid: 401, role: "worker", group: "worker" },
    { pid: 402, role: "spawned", group: "worker" },
  ]);
});

test("open-file collector distinguishes a supported empty sample from unavailable", async () => {
  const empty = await collectOpenFiles({ processes: [], codexHome: "/tmp", runtimeSupported: true });
  assert.equal(empty.available, process.platform !== "win32");
  assert.deepEqual(empty.items, []);
  const unavailable = await collectOpenFiles({ processes: [], codexHome: "/tmp", runtimeSupported: false });
  assert.equal(unavailable.available, false);
});
