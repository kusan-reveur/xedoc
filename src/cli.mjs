#!/usr/bin/env node

import { launchDashboard } from "./browser-launcher.mjs";
import { CodexInspector } from "./inspector.mjs";
import { displayPath, HELP, parseArgs } from "./config.mjs";
import { createXedocServer, listen } from "./server.mjs";

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
  console.log("Privacy:    loopback-only UI, read-only, no analytics; Insights uses cached fixed providers");
  console.log("Press Ctrl+C to stop.");

  launchDashboard(dashboardUrl, { open: options.open });
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
