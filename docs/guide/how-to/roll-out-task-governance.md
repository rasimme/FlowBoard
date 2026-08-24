# Roll out task-creation governance

The project Overview shows the current task-creation policy in its toolbar:

- **compat** is the safe observation mode. Requests that would require
  Specify are still created, and the policy ledger records them for review.
- **enforce** rejects those requests before a task is written and returns a
  recovery request for the Specify flow.

The mode is project-scoped. Anyone can read it, but only a verified Dashboard
human sees the switch control and can change it. Select **Enable** to switch to
enforcement after reviewing compatibility observations. If recovery volume is
unexpected, select **Rollback** to return to `compat` immediately.

The audit line records the server-verified actor and timestamp. Agents cannot
change the mode, and typing `human`, `agent`, or `approved` into an API request
does not grant permission. Legacy imports use the explicit migration path and
are not blocked; review the ledger after import before enabling enforcement.

See the [governance mode API reference](../../reference/api/governance.md) for
the response and recovery contract.
