# Remote access (Telegram Mini App)


FlowBoard can be accessed remotely as a Telegram Mini App through a secure tunnel.

Remote access exposes your local FlowBoard instance beyond localhost. Do not
start a tunnel until authentication is configured with bot token(s), an exact
ordered bot-to-agent mapping, a JWT secret, allowed user ids, and the public
dashboard origin. For non-Cloudflare tunnels
or any setup that does not add a trusted proxy header, set `AUTH_ALWAYS=true`
so loopback-only development bypasses cannot apply to remote traffic.

> See [`SECURITY.md`](../../../SECURITY.md) for the full threat model and trust boundary
> before exposing FlowBoard beyond localhost.

## Set up a tunnel

Any tunnel works. Recommended: **Cloudflare Tunnel** (free, stable).

```bash
cloudflared tunnel login
cloudflared tunnel create flowboard
cloudflared tunnel route dns flowboard flowboard.example.com
cp templates/cloudflare-config.yml ~/.cloudflared/config.yml
# Edit: replace placeholder values
cloudflared tunnel run flowboard
```

## Configure authentication

The standard service owns the authentication environment. On a first install,
provide the variables below to `node scripts/setup.mjs`; on an existing
standard service, change only explicitly named values with
`--override-env=KEY[,KEY...]`. Updates preserve the existing `JWT_SECRET` and
other service values unless you deliberately rotate or override them. Keep
real tokens and user IDs out of shell history, repositories, and chat.

### Linux (systemd --user)

```bash
# Generate once, then place the output in the owner-only auth configuration.
openssl rand -hex 32

mkdir -p ~/.config/systemd/user/flowboard-dashboard.service.d
cp templates/systemd-auth.conf.example \
   ~/.config/systemd/user/flowboard-dashboard.service.d/auth.conf
chmod 600 ~/.config/systemd/user/flowboard-dashboard.service.d/auth.conf
# Edit with your values:
# - TELEGRAM_BOT_TOKEN (primary token from @BotFather)
# - TELEGRAM_BOT_TOKENS (optional additional tokens, in stable order)
# - FLOWBOARD_TELEGRAM_AGENT_IDS (one agent id per token, in the same order)
# - JWT_SECRET
# - ALLOWED_USER_IDS (comma-separated allowed user ids)
# - DASHBOARD_ORIGIN (your public URL)
# - FLOWBOARD_TRUSTED_PROXY_IPS (optional: immediate proxy/tunnel peer IPs or CIDRs;
#   for local cloudflared, typically 127.0.0.1,::1)

systemctl --user daemon-reload
systemctl --user restart flowboard-dashboard
```

### macOS (launchd)

`node scripts/setup.mjs` creates and loads the standard LaunchAgent at
`~/Library/LaunchAgents/ai.openclaw.flowboard-dashboard.plist`. On first
install, set the same ordered bot/auth variables in the setup environment.
For an existing service, use explicit `--override-env` keys or edit that
owner-only plist with a plist-aware editor; do not replace it with a Linux
unit. After a direct plist edit, reload the job:

```bash
PLIST="$HOME/Library/LaunchAgents/ai.openclaw.flowboard-dashboard.plist"
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.flowboard-dashboard"
launchctl print "gui/$(id -u)/ai.openclaw.flowboard-dashboard" >/dev/null
```

The generated plist keeps `RunAtLoad` and `KeepAlive`, stores logs at
`~/Library/Logs/FlowBoard/flowboard-dashboard.log`, and uses owner-only
permissions. Its `EnvironmentVariables` dictionary must contain the same
one-to-one ordered mapping as the Linux example below:

```xml
<key>TELEGRAM_BOT_TOKEN</key><string>&lt;PRIMARY_BOT_TOKEN&gt;</string>
<key>TELEGRAM_BOT_TOKENS</key><string>&lt;DEVELOPMENT_BOT_TOKEN&gt;,&lt;DESIGN_BOT_TOKEN&gt;</string>
<key>FLOWBOARD_TELEGRAM_AGENT_IDS</key><string>main,dev-agent,design-agent</string>
<key>JWT_SECRET</key><string>&lt;GENERATED_JWT_SECRET&gt;</string>
<key>ALLOWED_USER_IDS</key><string>&lt;TELEGRAM_USER_ID&gt;</string>
<key>DASHBOARD_ORIGIN</key><string>https://flowboard.example.com</string>
```

`setup.mjs --update` reads the existing standard service, ordered
`EnvironmentFile=` sources, and systemd drop-ins without printing their values,
then writes the generated service definition owner-only. Persisted values win
over the caller's shell unless a key is explicitly named with `--override-env`.
Rotate the JWT only when intended with `node scripts/setup.mjs --rotate-secret`.
If a setting is owned by a systemd drop-in or `EnvironmentFile`, edit that
owner-only source instead; setup refuses to shadow it in the generated unit.

For three bots, the ordered mapping looks like this (placeholders only — never
commit real tokens):

```ini
Environment="TELEGRAM_BOT_TOKEN=<PRIMARY_BOT_TOKEN>"
Environment="TELEGRAM_BOT_TOKENS=<DEVELOPMENT_BOT_TOKEN>,<DESIGN_BOT_TOKEN>"
Environment="FLOWBOARD_TELEGRAM_AGENT_IDS=main,dev-agent,design-agent"
Environment="JWT_SECRET=<GENERATED_JWT_SECRET>"
Environment="ALLOWED_USER_IDS=<TELEGRAM_USER_ID>"
Environment="DASHBOARD_ORIGIN=https://flowboard.example.com"
```

Position 1 always maps `TELEGRAM_BOT_TOKEN`; positions 2+ map the comma-separated
entries in `TELEGRAM_BOT_TOKENS`. `FLOWBOARD_TELEGRAM_AGENT_IDS` must have the
same number and order of unique, valid agent IDs. Empty entries, duplicate
tokens/agent IDs, or a count mismatch stop startup with a diagnostic that never
prints token values. Open each Mini App once without another bot's cookie to
verify that `/api/auth` returns its server-confirmed `agentId`.

Cloudflare forwarding headers are not trusted solely because `cf-ray` is
present. `FLOWBOARD_TRUSTED_PROXY_IPS` affects only rate-limit identity; it is
not an authentication bypass. Set it to the immediate socket peer(s) that are
exclusively trusted to forward requests (for a local `cloudflared`, its
loopback address). If it is unset or contains invalid entries, rate-limit keys
fall back to the transport socket address; this is fail-safe but aggregates
remote tunnel clients behind the local proxy. Never list a routable client
network as a trusted proxy.

## Register Telegram button

1. Open @BotFather → `/setmenubutton`
2. Select your bot
3. Send your public dashboard URL
4. Send button label (e.g. "Dashboard")
