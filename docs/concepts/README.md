# Concepts

Conceptual docs that explain *why* FlowBoard works the way it does. One concept per file. These are the documents to read when you want to understand a part of FlowBoard's architecture without reading the code.

Each concept doc answers five questions:

1. What is this concept?
2. Why does it exist (which problem does it solve)?
3. How does it interact with the rest of FlowBoard?
4. What are the practical consequences for agents and users?
5. Where does the code live?

## Available concepts

<!-- Concept docs are added here as they are written. Stub-only directories should not list links yet. -->

- [Lazy Loading](lazy-loading.md) — how rule sections are loaded on demand, the manifest/section split, and the eager-load escape hatch for external agents
- [Agent Identity](agent-identity.md) — agent-id as a string contract, the OpenClaw vs. FlowBoard layers, lazy registration, attribution
- [Hook Architecture](hook-architecture.md) — the single `agent:bootstrap` subscription, what it mutates, why no other events
- [Multi-Agent Model](multi-agent-model.md) — `flowboard_agents` vs. `tasks_current.agent`, lazy registration, claim/release/handoff

## See also

- [Architecture Decision Records](../adr/) — the *what was decided* layer
- [Reference](../reference/) — the *facts and tables* layer
