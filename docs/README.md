# FlowBoard documentation

Pick your path — the docs are organized by who you are:

## 🧑 Use FlowBoard

You run the dashboard and want to get things done.

- [User guide](guide/) — getting started, searching, mobile use, managing projects.
- [FlowBoard inside OpenClaw](guide/openclaw-control-ui.md) — the dashboard as a native Control UI page, with a widget and a session panel.
- [README](../README.md) — overview and quick start.
- [Install FlowBoard](guide/install.md) — host versions, install consent, updating, manual install.

## 🤖 Connect an agent

You're wiring an agent (OpenClaw, Claude Code, Codex, Cursor, …) to FlowBoard's API.

- [Use FlowBoard with external agents](guide/how-to/external-agents.md) — install the trigger snippet, pick a stable agent id.
- [Reference](reference/) — the API manifest and environment variables.

> Runtime rules under `docs/project-mode/` are served to active-project agents through the API (`GET /api/projects/:name/rules/:section`). They are operational, not written for human reading.

## 🏗️ Understand or contribute

You want to know why FlowBoard works the way it does, or change it.

- [Concepts](concepts/) — the *why* behind each subsystem.
- [Architecture Decision Records](adr/) — what was decided, when, and why.
- [CONTRIBUTING](../CONTRIBUTING.md) — workflow, conventions, and documentation discipline.
