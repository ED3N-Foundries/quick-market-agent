FROM oven/bun:1.4.4-alpine
USER root
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY agent ./agent
COPY shared ./shared
COPY server ./server
COPY <<'ENTRYEOF' /agent-entrypoint.sh
#!/bin/sh
set -u
mkdir -p /data/agent
if [ ! -f /data/agent/control.json ]; then
  cp /app/agent/control.json /data/agent/control.json
fi
chown bun:bun /data /data/agent /data/agent/control.json
cd /data

stop=0
child=0

on_term() {
  stop=1
  if [ "$child" != 0 ]; then
    kill -TERM "$child" 2>/dev/null || true
  fi
}

trap on_term INT TERM

delay=1
while true; do
  su-exec bun:bun bun /app/agent/index.ts &
  child=$!
  wait "$child" || true
  child=0
  if [ "$stop" -eq 1 ]; then
    exit 0
  fi
  sleep "$delay" || true
  if [ "$stop" -eq 1 ]; then
    exit 0
  fi
  if [ "$delay" -lt 30 ]; then
    delay=$((delay * 2))
    if [ "$delay" -gt 30 ]; then
      delay=30
    fi
  fi
done
ENTRYEOF
RUN chmod 755 /agent-entrypoint.sh
ENV NODE_ENV=production DB_PATH=/data/quick-market-agent.sqlite HOME=/tmp
ENTRYPOINT ["/agent-entrypoint.sh"]
