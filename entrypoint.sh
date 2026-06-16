#!/bin/bash
set -e

# 1. Start virtual display
Xvfb :99 -screen 0 1366x768x24 -ac &
export DISPLAY=:99
sleep 1

# 2. Start x11vnc — shares the Xvfb display over VNC on port 5900
x11vnc -display :99 -nopw -listen 0.0.0.0 -forever -shared -quiet &

# 3. Start noVNC — web browser access at http://localhost:6080
websockify --web=/usr/share/novnc/ 6080 localhost:5900 &

# 4. Start Chrome — no --no-sandbox needed because we run as chromeuser (non-root)
google-chrome-stable \
  --display=:99 \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --window-size=1366,768 \
  --disable-dev-shm-usage \
  --user-data-dir=/tmp/chrome-profile &

# 5. Wait until Chrome debug API is ready
echo "Waiting for Chrome..."
until curl -sf http://localhost:9222/json/version > /dev/null; do
  sleep 0.5
done
echo "Chrome ready."

# 6. Start the Node server
exec npx tsx src/index.ts
