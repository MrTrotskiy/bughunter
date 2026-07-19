#!/usr/bin/env bash
# Bring up the hygge-crm LOCAL stand as a bughunter target. Read-only toward the project:
# the only files written inside it are the gitignored .env files it cannot boot without.
#
# The stack shape is taken from the project's OWN e2e config (apps/e2e/playwright.config.ts),
# not guessed: backend on 3201 against hr_crm_e2e, frontend preview on 5274 proxying to it,
# Redis DB index 1. That isolation is why crawling this stand cannot touch dev data.
#
# NOTHING here reaches the network beyond package installs: auth is a locally minted JWT
# (apps/e2e/src/setup/local-auth.ts), never Google OAuth.
set -euo pipefail

CRM="${CRM:-/Users/anton/projects/personal/hygge-crm}"
cd "$CRM"

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "prerequisites"
docker info >/dev/null 2>&1 || { echo "Docker is not running — start Docker Desktop first."; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm missing — run: corepack enable && corepack prepare pnpm@latest --activate"; exit 1; }

step "env files (gitignored; created only if absent)"
for app in backend frontend; do
  if [ ! -f "apps/$app/.env" ]; then
    cp "apps/$app/.env.example" "apps/$app/.env"
    echo "created apps/$app/.env"
  else
    echo "apps/$app/.env already exists — left alone"
  fi
done
# A local JWT secret. This is what local-auth.ts signs with, so the crawler's session and the
# backend's verification agree. Never a real secret — the stand is local-only.
if grep -q '^JWT_SECRET=your-super-secret' apps/backend/.env 2>/dev/null; then
  SECRET="$(openssl rand -base64 32)"
  # BSD sed (macOS) needs the empty -i argument.
  sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" apps/backend/.env
  echo "set a local JWT_SECRET"
fi
if grep -q '^DOC_ENCRYPTION_KEY=$' apps/backend/.env 2>/dev/null; then
  sed -i '' "s|^DOC_ENCRYPTION_KEY=.*|DOC_ENCRYPTION_KEY=$(openssl rand -base64 32)|" apps/backend/.env
  echo "set a local DOC_ENCRYPTION_KEY"
fi

step "install"
pnpm install

step "postgres + redis"
pnpm docker:up

step "e2e database (hr_crm_e2e on 5433) — built from scratch, NOT cloned from dev"
# db:e2e:setup aliases db:e2e:clone, which needs an existing dev DB. create+migrate+seed
# builds the same baseline from nothing, which is what a fresh checkout needs.
pnpm db:e2e:create
pnpm db:e2e:migrate
pnpm db:e2e:seed

step "build (frontend preview serves a real build, per their e2e config)"
pnpm --filter @hygge/shared build
pnpm --filter @hygge/frontend build

cat <<'DONE'

== stand ready — start the two servers in SEPARATE terminals ==

  # backend (port 3201, e2e DB, Redis index 1)
  cd /Users/anton/projects/personal/hygge-crm && \
    USE_DEV_DATABASE=false \
    DATABASE_URL='postgresql://postgres:postgres@localhost:5433/hr_crm_e2e?schema=public' \
    PORT=3201 CORS_ORIGINS=http://localhost:5274 REDIS_URL=redis://localhost:6379/1 \
    pnpm --filter @hygge/backend start

  # frontend (port 5274, proxies /api to 3201)
  cd /Users/anton/projects/personal/hygge-crm && \
    VITE_PORT=5274 VITE_PROXY_TARGET=http://localhost:3201 \
    pnpm --filter @hygge/frontend exec vite preview

Then the target URL is  http://localhost:5274
Seeded users: admin@acme-corp.example.com (super_admin), employee@acme-corp.example.com

DONE
