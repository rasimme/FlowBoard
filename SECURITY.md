# Security Policy

## Reporting a Vulnerability

If you discover a security issue, please **do not** open a public issue.

Instead, contact the maintainer privately:
- **GitHub:** open a private security advisory (preferred)

We aim to respond within **72 hours**.

## Scope / Notes

FlowBoard is designed to be **local-first** and typically runs on a private machine.

Common sensitive data includes:
- OpenClaw webhook tokens (`OPENCLAW_HOOKS_TOKEN`)
- Telegram bot tokens (`TELEGRAM_BOT_TOKEN`)
- JWT secrets (`JWT_SECRET`)

**Policy:** never hardcode secrets in the repo. Use environment variables only.
