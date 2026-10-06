#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Exécuter ce script en root (sudo)." >&2
  exit 1
fi

repo="${REPO:-https://github.com/LucienLassalle/SDP.git}"
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
apt-get install -y curl docker-compose docker.io git openssl systemd-resolved

systemctl enable --now docker.service systemd-resolved.service
install -d -m 0755 /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNS=%s\n' "$dns_server" > /etc/systemd/resolved.conf.d/sdp.conf
systemctl restart systemd-resolved.service

if [ -d "$install_dir/.git" ]; then
  git -C "$install_dir" pull --ff-only origin main
elif [ -e "$install_dir" ]; then
  echo "$install_dir existe mais n'est pas un dépôt Git." >&2
  exit 1
else
  git clone --branch main "$repo" "$install_dir"
fi

cd "$install_dir"
install -d -m 0700 secrets /etc/sysusers.d
if [ ! -s secrets/db_password ]; then
  (umask 077; openssl rand -hex 32 > secrets/db_password)
fi
chmod 0644 secrets/db_password

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

install -m 0644 deploy/sdp.sysusers /etc/sysusers.d/sdp.conf
systemd-sysusers
install -m 0644 deploy/sdp-check.service deploy/sdp-deploy.service \
  deploy/sdp-deploy.timer /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/sdp-check.service \
  /etc/systemd/system/sdp-deploy.service /etc/systemd/system/sdp-deploy.timer

docker compose version >/dev/null
getent hosts api.github.com >/dev/null
systemctl enable --now sdp-deploy.timer
systemctl start sdp-deploy.service

echo "Installation terminée. Version déployée : $(cat /var/lib/sdp-deploy/.current-tag)"
