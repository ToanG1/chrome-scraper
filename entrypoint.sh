#!/bin/bash
set -e

# 1. Start virtual display
# Remove stale lock files left behind by docker compose restart (not a full recreation)
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
# Remove stale Chrome profile lock files left by the previous container
rm -f /tmp/chrome-profile/SingletonLock /tmp/chrome-profile/SingletonCookie /tmp/chrome-profile/SingletonSocket
Xvfb :99 -screen 0 1366x768x24 -ac &
export DISPLAY=:99
sleep 1

# 2. Start x11vnc — shares the Xvfb display over VNC on port 5900
x11vnc -display :99 -nopw -listen 0.0.0.0 -forever -shared -quiet &

# 3. Start noVNC — web browser access at http://localhost:6080
websockify --web=/usr/share/novnc/ 6080 localhost:5900 &

# 4. Start Chrome — no --no-sandbox needed because we run as chromeuser (non-root)
# Optional: set PROXY_SERVER=host:port to route Chrome through a Japanese IP.
# Raw uule=lat,lon only works when the request IP matches Japan (e.g. via Bright Data
# or any JP residential/datacenter proxy). Without a JP proxy Google ignores the coords.
PROXY_ARG=""
if [ -n "$PROXY_SERVER" ]; then
  PROXY_ARG="--proxy-server=$PROXY_SERVER"
  echo "Chrome proxy: $PROXY_SERVER"
fi

google-chrome-stable \
  --display=:99 \
  $PROXY_ARG \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --no-first-run \
  --no-default-browser-check \
  --disable-infobars \
  --window-size=1366,768 \
  --disable-dev-shm-usage \
  --ignore-gpu-blocklist \
  --use-angle=swiftshader \
  --lang=ja \
  --user-data-dir=/tmp/chrome-profile &

# 5. Wait until Chrome debug API is ready
echo "Waiting for Chrome..."
until curl -sf http://localhost:9222/json/version > /dev/null; do
  sleep 0.5
done
echo "Chrome ready."

# 6. Start the Node server
exec npx tsx src/index.ts
