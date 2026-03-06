# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 4.x     | ✅ Active  |
| < 4.0   | ❌ No patches |

## Reporting a Vulnerability

If you discover a security issue, please **do not** open a public issue.

**Preferred:** Open a [private security advisory](https://github.com/rasimme/FlowBoard/security/advisories/new) on GitHub.

**Fallback:** Email `simeon.ortmueller@arcor.de` with subject `[SECURITY] FlowBoard`.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We aim to respond within **72 hours** and will coordinate disclosure with you.

## Scope

FlowBoard is designed to be **local-first** and typically runs on a private machine. Common sensitive data:

| Secret | Source |
|--------|--------|
| `OPENCLAW_HOOKS_TOKEN` | Webhook authentication |
| `TELEGRAM_BOT_TOKEN` | Telegram Mini App auth |
| `JWT_SECRET` | Session tokens |

**Policy:** All secrets must use environment variables. Never hardcode tokens in source code.
