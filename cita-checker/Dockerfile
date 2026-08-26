# For running the checker on a small VPS *inside Spain*.
# Build: docker build -t cita-checker .
# Run:   docker run -d --name cita --env-file .env --restart unless-stopped cita-checker
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY check.js lib.js run.sh ./
COPY test ./test

# cron-less loop: try every 3 minutes, the script honours ICP_WINDOWS itself.
CMD ["sh", "-c", "while true; do node check.js; sleep 180; done"]
