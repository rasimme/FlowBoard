#!/bin/bash
# Quick-start for development (production: use systemd)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
pkill -f "node server.js" 2>/dev/null
sleep 1
setsid node server.js > /tmp/dashboard-server.log 2>&1 &
echo "Dashboard API running on http://127.0.0.1:18790 (PID: $!)"
