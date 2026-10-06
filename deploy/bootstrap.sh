#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Exécuter ce script en root (sudo)." >&2
  exit 1
fi

repo="${REPO:-LucienLassalle/SDP}"
install_dir=/opt/sdp
env_file="$install_dir/deploy/.env"

if [ ! -f "$env_file" ] && [ -z "${TLS_SAN:-}" ]; then
  echo "Définir TLS_SAN pour le nom ou l'adresse IP du serveur." >&2
  exit 1
fi

if [ -n "${TLS_SAN:-}" ] && ! [[ "$TLS_SAN" =~ ^[A-Za-z0-9:.,_-]+$ ]]; then
  echo "TLS_SAN contient des caractères non autorisés." >&2
  exit 1
fi

https_bind="${HTTPS_BIND:-0.0.0.0}"
https_port="${HTTPS_PORT:-443}"
if ! [[ "$https_bind" =~ ^[A-Fa-f0-9:.]+$ ]] || \
  ! [[ "$https_port" =~ ^[0-9]+$ ]] || \
  [ "$https_port" -lt 1 ] || [ "$https_port" -gt 65535 ]; then
  echo "HTTPS_BIND ou HTTPS_PORT invalide." >&2
  exit 1
fi

# Preserve the DHCP-provided resolver before systemd-resolved replaces resolv.conf.
dns_server="${DNS_SERVER:-}"
if [ -z "$dns_server" ] && [ -r /etc/resolv.conf ]; then
  dns_server=$(awk '$1 == "nameserver" && $2 !~ /^127\./ && $2 != "::1" { print $2; exit }' /etc/resolv.conf)
fi
if [ -z "$dns_server" ] && command -v resolvectl >/dev/null 2>&1; then
  dns_server=$(resolvectl dns 2>/dev/null | awk 'NR == 1 { for (i = 2; i <= NF; i++) if ($i !~ /^Link/) { print $i; exit } }')
fi
if [ -z "$dns_server" ] || ! [[ "$dns_server" =~ ^[A-Fa-f0-9:.]+$ ]]; then
  echo "DNS introuvable. Définir DNS_SERVER avec l'adresse IP du résolveur." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl docker-compose docker.io openssl rsync systemd-resolved unzip util-linux

systemctl enable --now docker.service systemd-resolved.service
install -d -m 0755 /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNS=%s\n' "$dns_server" > /etc/systemd/resolved.conf.d/sdp.conf
systemctl restart systemd-resolved.service

if ! [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "REPO invalide : '$repo'" >&2
  exit 1
fi

auth=()
if [ -n "${GH_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer $GH_TOKEN")
fi
latest=$(curl -fsS --retry 3 "${auth[@]}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$repo/releases/latest" \
  | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
if ! [[ "$latest" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]]; then
  echo "Release introuvable ou tag invalide : '$latest'" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsS --retry 3 -D "$work/headers" -o /dev/null \
  -H "Accept: application/vnd.github+json" "${auth[@]}" \
  "https://api.github.com/repos/$repo/zipball/$latest"
location=$(awk 'tolower($1) == "location:" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$work/headers")
expected_location="https://codeload.github.com/$repo/legacy.zip/refs/tags/$latest"
if [ "$location" != "$expected_location" ]; then
  echo "URL d'archive GitHub inattendue : '$location'" >&2
  exit 1
fi
curl -fsS --retry 3 "${auth[@]}" "$location" -o "$work/source.zip"
unzip -tq "$work/source.zip"
unzip -Z1 "$work/source.zip" > "$work/entries"
archive_root=""
while IFS= read -r entry; do
  if [[ "$entry" = /* || "$entry" == *../* || "$entry" == ../* || "$entry" == *\\* ]]; then
    echo "Chemin invalide dans l'archive : '$entry'" >&2
    exit 1
  fi
  root="${entry%%/*}"
  if [ -z "$archive_root" ]; then
    archive_root="$root"
  elif [ "$root" != "$archive_root" ]; then
    echo "L'archive contient plusieurs racines." >&2
    exit 1
  fi
done < "$work/entries"
expected_root="${repo//\//-}"
if [ -z "$archive_root" ] || [[ "$archive_root" != "$expected_root-"* ]]; then
  echo "Racine d'archive inattendue : '$archive_root'" >&2
  exit 1
fi
mkdir "$work/extracted"
unzip -q "$work/source.zip" -d "$work/extracted"
source_dir="$work/extracted/$archive_root"
for required in docker-compose.yml deploy/sdp.sysusers deploy/sdp-check.service \
  deploy/sdp-deploy.service deploy/sdp-deploy.timer deploy/sdp-release-sync.service \
  deploy/sync-release.sh; do
  if [ ! -f "$source_dir/$required" ]; then
    echo "Fichier requis absent de la release $latest : $required" >&2
    exit 1
  fi
done
install -d -m 0755 "$install_dir" /etc/sysusers.d
install -d -m 0755 /usr/local/libexec
rsync -a --delete --safe-links \
  --exclude='/.git/' --exclude='/secrets/' --exclude='/deploy/.env' \
  "$source_dir/" "$install_dir/"
if [ -d "$install_dir/.git" ] || [ -L "$install_dir/.git" ]; then
  rm -rf -- "$install_dir/.git"
fi

install -d -m 0700 "$install_dir/secrets"
if [ ! -s "$install_dir/secrets/db_password" ]; then
  (umask 077; openssl rand -hex 32 > "$install_dir/secrets/db_password")
fi
chmod 0644 "$install_dir/secrets/db_password"

if [ ! -e "$env_file" ]; then
  session_secret="${SESSION_SECRET:-$(openssl rand -hex 32)}"
  if ! [[ "$session_secret" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "SESSION_SECRET doit contenir uniquement lettres, chiffres, '_' ou '-'." >&2
    exit 1
  fi
  if [ -n "${GH_TOKEN:-}" ] && ! [[ "$GH_TOKEN" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "GH_TOKEN contient des caractères non autorisés." >&2
    exit 1
  fi
  gh_user="${GH_USER:-${GITHUB_USER:-}}"
  if [ -n "$gh_user" ] && ! [[ "$gh_user" =~ ^[A-Za-z0-9-]+$ ]]; then
    echo "GH_USER contient des caractères non autorisés." >&2
    exit 1
  fi
  {
    printf 'SESSION_SECRET=%s\n' "$session_secret"
    printf 'HTTPS_BIND=%s\nHTTPS_PORT=%s\n' "$https_bind" "$https_port"
    printf 'TLS_SAN=%s\n' "$TLS_SAN"
    if [ -n "${GH_TOKEN:-}" ]; then
      printf 'GH_TOKEN=%s\nGH_USER=%s\n' "$GH_TOKEN" "$gh_user"
    fi
  } > "$env_file"
fi
chmod 0600 "$env_file"

install -m 0644 "$install_dir/deploy/sdp.sysusers" /etc/sysusers.d/sdp.conf
systemd-sysusers
for unit in "$install_dir"/deploy/sdp-*.service "$install_dir"/deploy/sdp-*.timer; do
  [ -f "$unit" ] || continue
  install -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
install -m 0755 "$install_dir/deploy/sync-release.sh" /usr/local/libexec/sdp-release-sync
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/sdp-*.service /etc/systemd/system/sdp-*.timer

docker compose version >/dev/null
getent hosts api.github.com >/dev/null
systemctl enable --now sdp-deploy.timer
systemctl restart sdp-deploy.timer
systemctl start sdp-release-sync.service

echo "Installation terminée. Release synchronisée : $(cat /var/lib/sdp-release-sync/source-tag)"
echo "Image déployée : $(cat /var/lib/sdp-deploy/.current-tag)"
