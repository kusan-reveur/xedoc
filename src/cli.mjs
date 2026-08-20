#!/usr/bin/env node

import { spawn } from "node:child_process";
import { CodexInspector } from "./inspector.mjs";
import { displayPath, HELP, parseArgs } from "./config.mjs";
import { createXedocServer, listen } from "./server.mjs";

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "/usr/bin/open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", (error) => {
    console.warn(`xedoc: could not open the browser automatically (${error.message}).`);
  });
  child.unref();
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`xedoc: ${error.message}`);
    console.error("Run xedoc --help for usage.");
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const inspector = new CodexInspector({ codexHome: options.codexHome, sqliteHome: options.sqliteHome });
  const { server, token } = createXedocServer({ inspector, host: options.host });
  let address;
  try {
    address = await listen(server, options);
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      console.error(`xedoc: port ${options.port} is already in use; retry with --port 0 or another port.`);
    } else {
      console.error(`xedoc: could not start the local server (${error.message}).`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Xedoc — Codex, in plain sight.");
  const dashboardUrl = `${address.url}#token=${encodeURIComponent(token)}`;
  console.log(`Dashboard:   ${dashboardUrl}`);
  console.log(`Codex home: ${displayPath(options.codexHome)}`);
  console.log("Privacy:    loopback-only, read-only, no analytics, no remote assets");
  console.log("Press Ctrl+C to stop.");

  if (options.open) openBrowser(dashboardUrl);
  const shutdown = () => {
    const forceClose = setTimeout(() => server.closeAllConnections?.(), 1_500);
    forceClose.unref();
    server.close(() => {
      clearTimeout(forceClose);
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await main();
