# ADR-0029: Local-first single-operator security boundary

## Status
Accepted (2026-06-25, T-422-4)

## Date
2026-06-25

## Source
- Threat model: `SECURITY.md`.
- Code: the v5.0.x hardening guards — lease ownership across every mutation path (`dashboard/hzl-service.js`, `dashboard/server.js`), typed confirmation + append-only audit log (`dashboard/audit-log.js` and the destructive endpoints), the boot bind guard (`dashboard/server.js`).
- Supersedes the multi-user / capability-tier direction explored in epic **T-418** (closed as out-of-scope).
- Builds on [ADR-0028](0028-auth-model-middleware.md) (auth model) and [ADR-0003](0003-dashboard-has-no-agent-identity.md) (`agentId` is attribution, not identity).

## Context
The ClawHub marketplace audit (flowboard@5.0.3, verdict "Review", 77 findings) raised "agent control surface / excessive agency" concerns: the local service exposes a powerful API and trusts any loopback caller. The obvious heavy response was a v5.1 architecture — a capability/permission model, `AUTH_ALWAYS` by default, a hard cryptographic caller identity, a keychain-backed secret store, and ultimately a multi-user / tenant / RBAC model.

The decisive fact: **OpenClaw — the host FlowBoard plugs into — is single-user / personal by design.** Its "multi" is multi-*channel* and multi-*agent* under one human operator, not multi-*human*. It has no user accounts, no tenants, and no role model; "multi-user" appears only as a "lock it down if you expose it" caveat. FlowBoard runs as a plugin for that one operator. There is therefore no second human principal *inside the product's model* to authorize against.

## Decision
FlowBoard's security boundary is **local-first, single-trusted-operator**.

- **Loopback == the operator.** Admission is origin + credentials + config ([ADR-0028](0028-auth-model-middleware.md)); once admitted, every endpoint trusts the caller equally. `agentId` / `actor` is **attribution, not authorization** ([ADR-0003](0003-dashboard-has-no-agent-identity.md)).
- **We do NOT build** a multi-user / tenant / RBAC model, capability tiers, or a hard cryptographic caller identity. With one human principal, those would be defending the operator from themselves; same-OS-user process isolation is the operating system's job and is explicitly out of scope.
- **We DO enforce, server-side, the invariants that prevent *accidental* cross-agent damage and keep actions answerable** — the legitimate residue of the audit under this model:
  - **Lease ownership on every mutation path.** claim / checkpoint / complete / release already rejected a non-owner (`NOT_OWNER`); the generic `PUT /tasks/:id` status path now does too (T-422-1). An actor-less caller is the trusted operator/UI; an explicit `adminOverride` is the deliberate back-door.
  - **Typed confirmation + an append-only audit log** on high-blast-radius destructive actions (task hard-delete/cascade, empty-trash, canvas batch-delete, project hard-delete, and force-deleting an agent that holds live claims — T-422-2).
  - **Fail-closed boot guard** (T-422-3): refuse to bind a non-loopback host while auth is disabled unless the operator explicitly accepts the risk (`FLOWBOARD_ALLOW_LAN=true`), then warn loudly.
  - **An honest threat model** in `SECURITY.md` that states the trust boundary plainly rather than implying access control the product does not provide.

## Consequences
- The real driver of the "Review" verdict — the trust model — is addressed by **disclosure plus bounded, audited capabilities**, not by an auth/RBAC build-out. The 5.0.4 re-scan moved the verdict to **benign** (high confidence) on exactly this basis.
- **Multi-user FlowBoard is out-of-scope** unless and until OpenClaw becomes multi-tenant. If that changes, the re-open items (capability model, `AUTH_ALWAYS` by default, keychain-backed secrets, hard caller identity — the ex-T-418 set) should be reconsidered then, against a real second principal.
- The boundary is **origin + admission + accidental-damage invariants**, not per-principal authorization. A co-resident process that forges or omits an asserted identity is not defended against here — that is the OS's responsibility, and it is stated as such.
