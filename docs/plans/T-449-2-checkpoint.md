# T-449-2 checkpoint

The existing-project migration derives `taskDiscipline` from the same creation
signals as the live flow, including a GitHub binding. A bound
`rasimme/FlowBoard` project therefore migrates to `development`.

For the live/DB-shaped verification fixture (`flowboard`, `handbook`,
`inbox`), the exact result is:

| discipline | count |
| --- | ---: |
| list | 1 |
| standard | 1 |
| development | 1 |

`GET /api/projects/:name/governance/mode` is removed; task-discipline is the
supported contract.
