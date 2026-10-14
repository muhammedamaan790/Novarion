#!/bin/sh
# Start the API, wait until it is ready, then serve the app. The accounts file comes from the NOVARION_USERS_JSON
# Space secret (salted scrypt hashes from scripts/users.py), so no account data is in the public Space files.
set -e
mkdir -p /tmp/novarion
if [ -n "$NOVARION_USERS_JSON" ]; then
  printf '%s' "$NOVARION_USERS_JSON" > /tmp/novarion/users.json
  chmod 600 /tmp/novarion/users.json
else
  echo "NOVARION_USERS_JSON is not set: sign-in is off" >&2
fi
uvicorn app.main:app --host 127.0.0.1 --port 8000 &
api=$!
for i in $(seq 1 60); do
  python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/ready').status == 200 else 1)" 2>/dev/null && break
  kill -0 "$api" 2>/dev/null || { echo "the API exited during start-up" >&2; exit 1; }
  sleep 1
done
exec nginx -g 'daemon off;'
