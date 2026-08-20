import { spawn } from "node:child_process";
import { childEnvironment } from "./utils.mjs";

export function openBrowser(url, {
  platform = process.platform,
  spawnImpl = spawn,
  sourceEnvironment = process.env,
  warn = (message) => console.warn(message),
} = {}) {
  let command;
  let args;
  if (platform === "darwin") {
    command = "/usr/bin/open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: childEnvironment(sourceEnvironment),
  });
  child.once("error", (error) => {
    warn(`xedoc: could not open the browser automatically (${error.message}).`);
  });
  child.unref();
  return child;
}

export function launchDashboard(url, { open = true, openImpl = openBrowser } = {}) {
  if (!open) return false;
  openImpl(url);
  return true;
}
