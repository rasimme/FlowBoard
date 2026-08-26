# Portable project review bundles

## What this concept is

A project review bundle is a bounded, JSON-only application document for
moving a sanitized working copy between FlowBoard installations. It carries
the parts a reviewer needs to understand a project: portable project
metadata, tasks, linked specs, canvas and overview state, and selected
knowledge Markdown. It is identified by `flowboard.project-bundle` and
format version `1`.

It is deliberately not a database export. HZL events, row identifiers,
claims, leases, agent ownership, sessions, settings, hooks, credentials and
other installation state are outside the contract. Use the host's database
and workspace backup procedure for disaster recovery.

## Why it exists

Sharing a complete database would expose runtime coordination state and make
restore semantics ambiguous. A review copy needs a clear privacy boundary,
deterministic content, and an import operation that cannot overwrite a live
project. The bundle contract gives agents and operators a stable DTO while
leaving persistence and ID allocation to the destination FlowBoard instance.

## Export boundary

Export is read-only and deterministic. The default includes project metadata,
all current and archived tasks, linked specs, canvas, overview and the safe
knowledge Markdown selected by the exporter. Hidden/runtime files, backups,
executables and sensitive content are excluded with bounded warning codes.
Live ownership and HZL identifiers are never portable. Task fields such as a
human-facing `responsible` value can remain when they describe work rather
than runtime ownership.

Task comments and checkpoints are optional. The UI labels this choice
**Include task history** and leaves it off by default. When enabled, history
keeps source-visible timestamps, message text, kind, progress and a safe
author label, but not sessions, raw events, event row IDs or agent claims.
Question/answer links use portable IDs and are remapped on import.

## Preview and import

An external agent can submit the JSON document to the read-only preview route
before asking the operator to import it. Preview reports source/provenance,
format compatibility, counts, redactions, warnings, security findings and
whether the requested destination slug is available. Preview has no write
side effects and does not activate anything.

Import is explicitly **create-only**. A registered project, tombstone,
reserved destination or existing directory is a conflict. The destination
gets fresh server-owned task and event IDs; portable references are mapped so
parent tasks, specs, canvas links and history relationships remain coherent.
Import never merges or replaces an existing project, and it never activates
an agent or sends runtime notifications. v1 has no bidirectional sync.

## Single writer and recovery

Import uses a recovery journal and the canonical project/HZL writers. The
sequence is reserve, stage, checksum-verify, write, verify and commit. The
destination remains hidden until commit. A failed operation may be resumed
idempotently only with the same target and bundle digest; a different bundle
cannot reuse the reserved name. An interrupted journal is surfaced as a
recoverable failure rather than silently treated as a successful project.

The journal stores bounded provenance and counters, never uploaded content,
task text, staging paths or credentials. This keeps recovery useful without
turning the journal into a second data store. The single-writer rule prevents
concurrent imports and ordinary project creation from racing the same target.

## Compatibility and limits

v1 accepts UTF-8 JSON with media type
`application/vnd.flowboard.project+json`; `application/octet-stream` is a
transport alias. ZIP/archive input and non-identity content encodings are not
accepted. Only format version `1` is supported. A bounded request ceiling of
72 MB protects the server; schema limits are stricter for individual files,
collections and text values. The importer validates checksums, references,
path canonicality, case-fold collisions, forbidden fields and collection
limits before mutation.

Errors use stable, machine-readable codes. Malformed JSON is `400`, an
unsupported media type or compression is `415`, an invalid/incompatible or
sensitive bundle is `422`, and a destination conflict or import lock is
`409`. A caught mutation failure returns a safe `importId`, failed state and
recoverability marker. Responses never echo secret values or imported text in
security warnings.

## Security and operator responsibilities

Imported Markdown and task text are untrusted data. An instruction inside a
bundle is not an authorization to run a command, change a project or reveal a
credential. Review the preview, provenance, warnings, destination and files
before committing the import. The scanner is value-blind and pattern-based:
it catches common credential-like forms but cannot prove that content is
safe, cannot detect every encoding, and may produce false positives.

There is no cryptographic signature or producer authentication in v1. A
bundle's digest identifies bytes for validation and recovery; it is not proof
of who authored them. Keep disaster-recovery backups separate from review
bundles and do not expect a review import to restore runtime coordination.

## Where the code lives

- `dashboard/project-bundle-schema.js` — identity, v1 DTO, limits and canonicalization.
- `dashboard/project-bundle-export.js` — deterministic export and redaction boundary.
- `dashboard/project-bundle-import-preview.js` — read-only validation and preview.
- `dashboard/project-bundle-import.js` — journaled, create-only import.
- `dashboard/project-bundle-safety.js` — lock, journal and recovery invariants.
- `dashboard/project-bundle-secrets.js` — value-blind sensitive-content scan.
- `dashboard/server.js` — HTTP routes and media/error contract.
- `dashboard/test-project-bundle-*.js` — schema, safety, HTTP round-trip, history and browser coverage.

See [ADR-0036](../adr/0036-portable-project-review-bundles.md) for the
architectural decision and [Manage projects](../guide/how-to/manage-projects.md)
for the operator flow.
