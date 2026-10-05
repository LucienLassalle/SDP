#!/usr/bin/env bash
# Écrit le tag de la dernière release GitHub dans $STATE_DIRECTORY/latest-tag
set -euo pipefail

REPO="${REPO:-LucienLassalle/SDP}"
state="${STATE_DIRECTORY:-deploy}"

auth=()
if [ -n "${GH_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer $GH_TOKEN")
fi

latest=$(curl -fsS "${auth[@]}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases/latest" \
  | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)

if ! [[ "$latest" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]]; then
  echo "Release introuvable ou tag invalide : '$latest'"
  exit 1
fi

echo "$latest" > "$state/latest-tag.new"
mv "$state/latest-tag.new" "$state/latest-tag"
