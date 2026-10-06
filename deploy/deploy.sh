#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-LucienLassalle/SDP}"
compose=(docker compose)
state="${STATE_DIRECTORY:-deploy}"
# Écrit par sdp-check.service, déjà validé
latest_file="${LATEST_TAG_FILE:-/var/lib/sdp-check/latest-tag}"

if [ -n "${GH_TOKEN:-}" ]; then
  # Identifiants enregistrés dans DOCKER_CONFIG (StateDirectory du service)
  echo "$GH_TOKEN" | docker login ghcr.io -u "${GH_USER:-${REPO%%/*}}" --password-stdin >/dev/null
fi

latest=$(cat "$latest_file")

current=$(cat "$state/.current-tag" 2>/dev/null || true)
failed=$(cat "$state/.failed-tag" 2>/dev/null || true)

if [ "$latest" = "$failed" ]; then
  exit 0
fi

record_digests() {
  local tag="$1"
  local digests_file="$state/.current-digests"
  local digests_file_new="$digests_file.new"
  local image repository repo_digest digest

  : > "$digests_file_new"
  for image in \
    "ghcr.io/${REPO,,}:$tag" \
    "ghcr.io/${REPO,,}-db:$tag" \
    "ghcr.io/${REPO,,}-tls:$tag"; do
    repository="${image%:*}"
    if ! repo_digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image"); then
      echo "Impossible de lire le digest de $image"
      rm -f "$digests_file_new"
      return 1
    fi
    digest="${repo_digest#"$repository@"}"
    if ! [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      echo "Digest absent ou invalide pour $image"
      rm -f "$digests_file_new"
      return 1
    fi
    printf '%s %s\n' "$image" "$digest" >> "$digests_file_new"
  done
  chmod 0600 "$digests_file_new"
}

if [ "$latest" = "$current" ]; then
  if ! record_digests "$current"; then
    exit 1
  fi
  if [ -s "$state/.current-digests" ] && ! cmp -s "$state/.current-digests.new" "$state/.current-digests"; then
    echo "Les digests locaux ne correspondent plus à ceux du déploiement $current"
    rm -f "$state/.current-digests.new"
    exit 1
  fi
  mv "$state/.current-digests.new" "$state/.current-digests"
  cat "$state/.current-digests"
  exit 0
fi

echo "Mise à jour : ${current:-aucune} -> $latest"
IMAGE_TAG="$latest" "${compose[@]}" pull web db tls

# --wait attend que les healthchecks des conteneurs soient au vert
if IMAGE_TAG="$latest" "${compose[@]}" up -d --no-build --wait --wait-timeout 120 \
  && record_digests "$latest"; then
  mv "$state/.current-digests.new" "$state/.current-digests"
  echo "$latest" > "$state/.current-tag"
  rm -f "$state/.failed-tag"
  cat "$state/.current-digests"
  echo "Version $latest en ligne"
  exit 0
fi

echo "La version $latest ne répond pas"
echo "$latest" > "$state/.failed-tag"
if [ -n "$current" ]; then
  echo "Retour à la version $current"
  IMAGE_TAG="$current" "${compose[@]}" up -d --no-build
fi
exit 1
