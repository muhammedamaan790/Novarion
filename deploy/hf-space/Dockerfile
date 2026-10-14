# NOVARION on a Hugging Face Docker Space (D-029): one container, because a Space runs one. nginx serves the built
# frontend on :7860 and proxies /api to uvicorn on 127.0.0.1:8000, as the two-container compose stack does. Only the
# production model bundle is copied in; the image runs as uid 1000, as Spaces require.
FROM node:22-alpine AS web
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY config /config
COPY contracts /contracts
COPY release_manifest.json /release_manifest.json
RUN npm run build

FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends nginx && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_PROJECT_ENVIRONMENT=/opt/venv PATH=/opt/venv/bin:$PATH
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --group inference
COPY ml ml
COPY backend backend
COPY config config
COPY contracts contracts
COPY registry registry
COPY artifacts/models/v1.0.2 artifacts/models/v1.0.2
COPY release_manifest.json release_manifest.json
COPY --from=web /app/dist /app/web
COPY deploy/hf-space/nginx.conf /etc/nginx/nginx.conf
COPY deploy/hf-space/start.sh /app/start.sh
RUN useradd -m -u 1000 user && chmod +x /app/start.sh
USER user
# Hosted mode: no in-app Promote. Sign-in on, from the NOVARION_USERS_JSON Space secret (see start.sh).
# The client address reaches the backend only through nginx on this container's loopback.
ENV PYTHONPATH=/app/ml:/app/backend NOVARION_RUN_MODE=live NOVARION_COOKIE_SECURE=1 \
    NOVARION_TRUST_PROXY=1 NOVARION_TRUSTED_PROXIES=127.0.0.1/32 NOVARION_USERS_FILE=/tmp/novarion/users.json
EXPOSE 7860
CMD ["/app/start.sh"]
