#!/bin/bash
# Starts the server detached, then actually verifies it's still alive a
# moment later. Without this check, a crash right after startup (bad
# ANTHROPIC_API_KEY, port already in use, a bug) went unnoticed -- the old
# inline npm script always printed a "running" message regardless of
# whether the process was still there, which is exactly the kind of lie
# that turns into a confusing 502 with no explanation later.

nohup node server.js > server.log 2>&1 &
echo $! > .server.pid
sleep 1

if kill -0 "$(cat .server.pid)" 2>/dev/null; then
  echo "InfiniScroll running in background (PID $(cat .server.pid)). Logs: tail -f server.log | Stop: npm run stop"
else
  echo "InfiniScroll FAILED to start. Last 20 lines of server.log:"
  echo "----------------------------------------"
  tail -20 server.log
  echo "----------------------------------------"
  rm -f .server.pid
  exit 1
fi
