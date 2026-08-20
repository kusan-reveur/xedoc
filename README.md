# Xedoc

**Codex, in plain sight.** Xedoc is a private, local-only dashboard for inspecting the disk, process, token, timing, and health metadata that Codex leaves on your machine.

## What it shows

- Codex/ChatGPT process count, OS-reported CPU, aggregate RSS, and uptime
- Strict Codex-worker memory separately from the wider host-app process family
- Thread counts, models, reasoning effort, source, timestamps, lifespan, and recorded tokens
- Observed thread-token totals by model, split by Codex reasoning/thinking level when recorded
- Token breakdown for the most recently active rollout, including cached and reasoning tokens
- Exact recent turn runtime and median time-to-first-token when those events are available
- Storage grouped into conversation history, logs, indexes, extensions, artifacts, caches, and runtime state
- The largest task histories, with linked subagent rollouts grouped under compact session-index task names and unlinked subagents labeled separately, plus app caches/logs and same-user Codex-like entries in the system temp directory
- A safe, lazy file browser for metadata under `CODEX_HOME`
- Warning/error counts and targets from structured logs without log bodies
- Goal token/time accounting when explicit Codex goals exist
- Codex reset announcement calendars in Overview and Insights, plus the past 30 days of source history from the public Codex Resets API
- Local model-and-thinking-level profiles with task count, total tokens, average tokens per task, and average thread wall span

Xedoc deliberately does **not** estimate the cost or standardized quality of your local work. Local ChatGPT/Codex subscription token activity is not equivalent to API billing, and local tasks are not comparable benchmark workloads.

## Run it

Xedoc needs Node.js 22.16 or newer and has no package dependencies.

```bash
node src/cli.mjs
```

The launch command opens the dashboard automatically and also prints the full loopback URL, including its secret `#token=…` fragment. The fragment is not sent in HTTP requests; the dashboard keeps it only in the browser session. To print the URL without launching a browser:

```bash
node src/cli.mjs --no-open
```

On a shared machine, prefer `--no-open` and copy the printed URL yourself: automatic opening briefly places the secret URL in the platform launcher command line.

Xedoc needs no third-party credentials. Reset history uses the public, anonymous Codex Resets API; model and thinking-level profiles are computed from the local read-only thread index.

Useful options:

```text
--port 0                 choose an available local port
--codex-home /path       override CODEX_HOME
--sqlite-home /path      override CODEX_SQLITE_HOME
```

The server rejects non-loopback bind addresses.

## Privacy and safety model

Xedoc is read-only by design:

- binds only to `127.0.0.1`, `::1`, or `localhost`;
- protects every metadata API with a random token delivered only in the CLI URL fragment and retained in browser session storage;
- validates Host and Origin headers and sends a restrictive Content Security Policy;
- contains no analytics, remote assets, or package dependencies;
- opens Codex SQLite databases in read-only/query-only mode;
- never offers delete, cleanup, archive, or configuration actions;
- never reads or returns raw auth/config contents, prompt/message fields, reasoning, commands, patches, tool output, log bodies, attachments, or browser data;
- displays only a bounded compact `thread_name` from Codex's session index to identify grouped task history; it never substitutes the SQLite title/preview fields, which may contain full opening messages;
- only parses one bounded selected/recent rollout tail at a time and whitelists known numeric/status fields;
- refuses to browse through symbolic links.

The Overview reset calendar and Insights panel make read-only outbound requests from the local server to one fixed public provider and cache them independently from the five-second local snapshot loop:

- `codex-resets.com` receives a UTC `from`/`to` range covering the past 30 days plus bounded sort/pagination controls;

As with any network request, the provider can also observe normal connection metadata such as the source IP and request time.

Reset history is cached in memory for five minutes. Provider failures affect only the reset panels. No third-party response or credential is written to disk by Xedoc.

External reads are capped at five pages, 500 reset records, and an aggregate JSON budget of 4 MiB. The dashboard marks results as partial when a cap is reached.

Task names, paths, filenames, thread IDs, process names, and repository locations are still metadata and may be sensitive. Treat screenshots and screen sharing accordingly.

The unauthenticated loopback root serves only the static dashboard shell. A local process or another OS account still needs the secret URL fragment to query metadata; anyone who can read your terminal output or browser session should be treated as authorized while Xedoc is running.

## Why the scanner is bounded

Rollout JSONL files can be several gigabytes, and content-heavy compaction records can be tens of megabytes per line. Xedoc therefore uses the versioned state database as a fast index, gathers file sizes from filesystem metadata, and reads at most a small tail of one selected or recent rollout at a time. It never rescans all conversation contents on refresh.

Conversation rollouts are persistent chat history, **not ordinary disposable temporary files**. Xedoc labels caches and temporary candidates separately and does not imply that history is safe to remove.

## Data sources

Xedoc discovers these sources rather than assuming a fixed version suffix:

- `CODEX_HOME` (normally `~/.codex`) for sessions, archives, logs, artifacts, plugins, packages, and cache state
- the newest compatible `state_*.sqlite`, `logs_*.sqlite`, and optional `goals_*.sqlite`
- `session_index.jsonl` for bounded task-name lookups after the largest histories have been selected
- a selected or newest rollout path indexed by the state database
- OS process tables and open-file metadata where permissions allow
- macOS Codex app support, cache, update-cache, log, and HTTP-storage directories
- Codex/OpenAI-named entries directly under known system temp roots
- the public [Codex Resets API](https://codex-resets.com/api/docs) for bounded reset-announcement history

Insights also links to [Artificial Analysis's public Codex comparison](https://artificialanalysis.ai/agents/coding-agents/comparisons/codex-vs-cursor-cli) for users who want a standardized external benchmark. Xedoc does not fetch, copy, or redistribute that data.

OpenAI documents `CODEX_HOME`, `CODEX_SQLITE_HOME`, local session persistence, logs, and opt-in OpenTelemetry in the [Codex environment-variable](https://learn.chatgpt.com/docs/config-file/environment-variables) and [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) documentation. The numbered SQLite schemas and rollout record shapes used for richer local metadata are internal and may change; Xedoc fails individual panels independently when a schema is unavailable.

## Metric caveats

- Aggregate RSS can count shared Electron memory more than once.
- CPU is the OS process table's reported percentage (its averaging window varies by platform) and can exceed 100% across multiple cores.
- Process uptime is not developer working time.
- Thread lifespan includes idle time.
- Recent exact runtime covers only completed turn events found in the bounded rollout tail.
- Daily token bars assign a thread's current total to its creation date; they are not billing or a precise daily consumption ledger.
- Cached input and reasoning output are subsets and are not added on top of total tokens.
- Reset timestamps are unofficial announcement times, not guaranteed reset-occurrence times.
- Model-and-thinking-level profiles describe the local tasks recorded in this Codex installation; they are not standardized quality or performance benchmarks.
- Average tokens per task use the current recorded thread total. Average thread span is `updated - created` wall time and can include idle time.
- Live Codex files can move, grow, archive, or disappear during a scan; Xedoc treats those races as normal.
- Safety budgets cap top-level, temporary, open-file, directory-browser, and rollout-candidate scans; the dashboard marks partial counts with `+` and partial byte totals as lower bounds.

Full process and disk-size collection currently targets macOS and Linux. On Windows, those collectors report unavailable rather than inventing totals; the metadata browser remains read-only and usable where the state schema is compatible.

## Development

```bash
node --test
node --check public/app.js
```

Or, if pnpm is available:

```bash
pnpm check
pnpm dev
```

The server and collectors use Node built-ins only. Tests cover privacy-safe JSONL parsing, read-only metadata queries, process-tree attribution, path containment/symlink rejection, and API session-token protection.
