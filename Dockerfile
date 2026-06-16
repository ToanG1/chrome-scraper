FROM node:20-slim

# node:20-slim already ships a non-root "node" user (UID 1000)
# We reuse it so Chrome runs without --no-sandbox

# Install Chrome + Xvfb + noVNC + Vietnamese/Japanese fonts
RUN apt-get update && apt-get install -y \
    wget gnupg curl xvfb x11vnc novnc websockify \
    fonts-noto fonts-noto-cjk \
    fonts-liberation libgconf-2-4 libxss1 \
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libnss3 libxkbcommon0 \
    --no-install-recommends \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
     > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y google-chrome-stable --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY src/ ./src/
COPY test/ ./test/
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh && chown -R node:node /app

ENV PORT=3000
EXPOSE 3000 6080

USER node
ENTRYPOINT ["./entrypoint.sh"]
