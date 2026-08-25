# T-449-4 checkpoint

The task API now supports an explicit `{ parent, subtasks }` batch contract.
All batch items are validated before the first write; children receive server
allocated IDs and `parentId`, preserve explicit priorities, inherit the parent
priority by default, and retain descriptions and per-item structure reviews.
Failures after a write use the HZL creation rollback purge, leaving no tasks
from the request. Coverage is in `dashboard/test-t449-4-batch-create.js`.
