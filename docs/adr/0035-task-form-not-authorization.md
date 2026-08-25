# ADR-0035: Task form, not authorization

**Status:** Accepted

FlowBoard validates only server-visible task shape. Project task discipline is
`list`, `standard`, or `development`; violations create a `structureReview`
marker and never block creation. Specify remains an optional clarification aid.

This follows ADR-0029: loopback is the operator boundary and `agent`/`actor` is
attribution, not a second authorization principal. Origin, timestamp, actor,
and the append-only audit trail provide provenance without claiming to verify a
human decision that FlowBoard cannot observe.
