# stare

`stare` is a CLI for following remote CI and build logs in real time.

Today it supports:

- GitHub Actions
- Expo EAS Build

## Why this exists

Official build CLIs often show status, links, or metadata well, but they do not always stream remote logs in real time.

That means you often end up with this split workflow:

- you have to open a browser tab to watch the live logs
- the terminal can tell you that a build is running, but not show the actual warnings and errors as they happen

`stare` is built for the opposite workflow.

You can run it immediately after pushing a commit or starting a build, and logs stream into your terminal as the remote job runs. That makes CI output feel much closer to local execution, which is useful both for humans and for AI agents that need to read warnings, failures, and build output directly.

The goal is faster iteration: start the remote build, watch it locally, and react as soon as something goes wrong.

## Install

```bash
npm install -g stare-cli
```

Or run it without installing globally:

```bash
npx stare-cli <command>
```

Requirements:

- Node.js 22+
- a Chromium-based browser installed locally for GitHub live logs
- for GitHub: either set `GITHUB_TOKEN` / pass `--token`, or install GitHub CLI and run `gh auth login`
- for Expo EAS Build: install EAS CLI and run `eas login`

## Quick Start

GitHub Actions:

```bash
stare gh auth login
stare gh run view
```

Expo EAS Build:

```bash
stare eas build view <build-id-or-url>
```

## Usage

### GitHub Actions

```bash
stare gh auth login
stare gh run view
stare gh run view <commit-sha>
stare gh run view <actions-url>
stare gh run view --run-id <run-id>
```

`stare gh run view` defaults to the current repo and the latest eligible run for each workflow on `HEAD`.

Common cases:

- no argument: watch the latest eligible runs for the current `HEAD`
- commit SHA: watch the matching runs for that commit
- Actions URL or `--run-id`: watch a specific run directly

For authentication:

- run `stare gh auth login` once to create the browser session used for live log streaming
- use `GITHUB_TOKEN`, `--token`, or `gh auth login` for GitHub API access

Example:

```bash
stare gh auth login
stare gh run view --run-id 123456789 --repo owner/repo
```

### Expo EAS Build

```bash
stare eas build view <build-id>
stare eas build view <expo-build-url>
```

`stare` reads Expo auth from `~/.expo/state.json`, so log in first with `eas login`.

Example:

```bash
stare eas build view 11111111-2222-4333-8444-555555555555
```

## Output model

`stare` prints the resolved target before streaming so it is obvious what it selected.

GitHub output is grouped by job, for example:

```text
[test] npm test
[lint] npm run lint
```

EAS output is grouped by build target, with phase headings and indented log lines, for example:

```text
[Android] Run gradlew
[Android]   > Task :app:assembleRelease
```

This keeps the stream readable while still working well for plain terminal use and for agent consumption.

## Architecture

- GitHub uses the REST API for run and job metadata, then Playwright plus browser session state for live job log streaming
- EAS uses Expo's GraphQL API for build metadata and tails signed JSONL log files exposed by the build

## Development

```bash
npm install
npm run build
npm test
```

The main entrypoint is `src/cli.ts`.

## Acknowledgements

`stare` was partly inspired by [`octotail`](https://github.com/getbettr/octotail/tree/main), which proved the value of following CI logs from the terminal.

`stare` takes a different approach in a few places:

- it does not require `mitmproxy`, which keeps setup lighter
- it supports Expo EAS Build in addition to GitHub Actions
- it keeps the provider model open so each platform can use the transport that fits it best
