#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-LucienLassalle/SDP}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/}"
compose=(docker compose)
state=deploy

auth=()
if [ -n "${GH_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer $GH_TOKEN")
fi

latest=$(curl -fsS "${auth[@]}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases/latest" \
  | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)

if ! [[ "$latest" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Release introuvable ou tag invalide : '$latest'"
  exit 1
fi

current=$(cat "$state/.current-tag" 2>/dev/null || true)
failed=$(cat "$state/.failed-tag" 2>/dev/null || true)

if [ "$latest" = "$current" ] || [ "$latest" = "$failed" ]; then
  exit 0
fi

echo "Mise à jour : ${current:-aucune} -> $latest"
IMAGE_TAG="$latest" "${compose[@]}" pull web
IMAGE_TAG="$latest" "${compose[@]}" up -d --no-build

for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "$HEALTH_URL"; then
    echo "$latest" > "$state/.current-tag"
    rm -f "$state/.failed-tag"
    echo "Version $latest en ligne"
    exit 0
  fi
  sleep 2
done

echo "La version $latest ne répond pas"
echo "$latest" > "$state/.failed-tag"
if [ -n "$current" ]; then
  echo "Retour à la version $current"
  IMAGE_TAG="$current" "${compose[@]}" up -d --no-build
fi
exit 1
