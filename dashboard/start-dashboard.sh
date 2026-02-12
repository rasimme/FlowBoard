#!/bin/bash
cd ~/.openclaw/workspace/canvas
pkill -f "node server.js" 2>/dev/null
sleep 1
setsid node server.js > /tmp/dashboard-server.log 2>&1 &
echo "Dashboard API running on http://127.0.0.1:3001 (PID: $!)"
