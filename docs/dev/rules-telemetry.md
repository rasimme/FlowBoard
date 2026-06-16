# Rules-endpoint telemetry

Temporary, diagnostic instrumentation on the `/api/projects/:name/rules` and
`/api/projects/:name/rules/:section` endpoints. Answers one question:

> Do agents actually use the lazy-load rules API, or are they ignoring it?

## What it logs

When `FLOWBOARD_RULES_TELEMETRY=1` is set in the server env, every hit on
either rules endpoint writes one line to stdout. The log path depends on the
service manager:

- systemd user service: usually `/tmp/dashboard.log`
- macOS launchd service: currently `/tmp/flowboard-dashboard.log`

```
[rules-telemetry] section=<name>|_manifest|<name>[404] agent=<id> project=<name>
```

- `section=_manifest` — the GET /rules manifest listing
- `section=<name>` — a successful GET /rules/:section fetch (e.g. `hzl`, `api-access`)
- `section=<name>[404]` — a 404 miss on an unknown section
- `agent=unknown` — no `agentId` query param or `X-OpenClaw-Agent-Id` header present

Off by default. Zero runtime overhead when the env var isn't `1`.

## Enabling on the live service

### systemd

```bash
systemctl --user edit flowboard-dashboard
# In the drop-in editor add:
#   [Service]
#   Environment=FLOWBOARD_RULES_TELEMETRY=1
systemctl --user restart flowboard-dashboard
```

### macOS launchd

```bash
PLIST=~/Library/LaunchAgents/ai.openclaw.flowboard-dashboard.plist
/usr/libexec/PlistBuddy -c 'Add :EnvironmentVariables:FLOWBOARD_RULES_TELEMETRY string 1' "$PLIST"
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.flowboard-dashboard"
```

Verify the flag is picked up:

```bash
curl -s http://localhost:18790/api/projects/flowboard/rules >/dev/null
grep "rules-telemetry" /tmp/dashboard.log /tmp/flowboard-dashboard.log 2>/dev/null | tail -5
# Expect: one new line with section=_manifest
```

## Reading the results

```bash
# Total hits since instrumentation was enabled
grep -h "rules-telemetry" /tmp/dashboard.log /tmp/flowboard-dashboard.log 2>/dev/null | wc -l

# Hits per section
grep -h "rules-telemetry" /tmp/dashboard.log /tmp/flowboard-dashboard.log 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i ~ /^section=/) print $i}' | sort | uniq -c | sort -rn

# Hits per agent
grep -h "rules-telemetry" /tmp/dashboard.log /tmp/flowboard-dashboard.log 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i ~ /^agent=/) print $i}' | sort | uniq -c | sort -rn

# Hits per day
grep -h "rules-telemetry" /tmp/dashboard.log /tmp/flowboard-dashboard.log 2>/dev/null | awk '{print $1}' | cut -d'T' -f1 | sort | uniq -c
```

## Interpreting outcomes

| Observation over several days | Interpretation | Action |
|---|---|---|
| Zero hits at all | Agents ignore the manifest entirely. BOOTSTRAP.md may not even be read, or the snippet isn't directive enough. | Tighten the snippet language ("on first message MUST GET /rules/api-access"), or consider API-response hints (gap #3). |
| Only `_manifest`, no section hits | Agents read BOOTSTRAP.md but never drill into details. | Consider whether the manifest is too dense or whether sections need different framing. |
| Manifest + some sections, skewed | Lazy-load works; a few sections do the heavy lifting. | No change. Maybe prune unused sections eventually. |
| All sections, balanced | Ideal case — lazy-load is genuinely load-bearing. | Leave it alone. |

## Removing the instrumentation

Once the question is answered:

1. Unset the env var in the service manager (`systemctl --user edit ...` on Linux, or remove `EnvironmentVariables:FLOWBOARD_RULES_TELEMETRY` from the launchd plist on macOS).
2. Remove the three log-emit sites + the `RULES_TELEMETRY` constant + `logRuleHit()` function from `dashboard/server.js` (search for `rules-telemetry`).
3. Delete this doc (`docs/dev/rules-telemetry.md`).
4. Commit as `remove: rules-telemetry instrumentation — answered <summary>`.

Total removal is ~15 lines. Intentionally cheap to uninstall.
