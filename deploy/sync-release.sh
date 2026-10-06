#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Exécuter ce script en root." >&2
  exit 1
fi

REPO="${REPO:-LucienLassalle/SDP}"
install_dir=/opt/sdp
unit_dir=/etc/systemd/system
libexec_dir=/usr/local/libexec
state="${STATE_DIRECTORY:-/var/lib/sdp-release-sync}"
latest_file="${LATEST_TAG_FILE:-/var/lib/sdp-check/latest-tag}"

if ! [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "REPO invalide : '$REPO'" >&2
  exit 1
fi

latest=$(cat "$latest_file")
if ! [[ "$latest" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]]; then
  echo "Tag de release invalide : '$latest'" >&2
  exit 1
fi

install -d -m 0750 "$state"
install -d -m 0755 "$install_dir" "$unit_dir" "$libexec_dir"
lock_file="$state/deploy.lock"
touch "$lock_file"
chgrp sdp-deploy "$lock_file"
chmod 0660 "$lock_file"
exec 9>>"$lock_file"
flock 9

current=$(cat "$state/source-tag" 2>/dev/null || true)
if [ "$latest" != "$current" ]; then
  work=$(mktemp -d "$state/work.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  archive="$work/source.zip"
  headers="$work/headers"
  extracted="$work/extracted"
  mkdir -m 0700 "$extracted"

  auth=()
  if [ -n "${GH_TOKEN:-}" ]; then
    auth=(-H "Authorization: Bearer $GH_TOKEN")
  fi

  curl -fsS --retry 3 -D "$headers" -o /dev/null \
    -H "Accept: application/vnd.github+json" "${auth[@]}" \
    "https://api.github.com/repos/$REPO/zipball/$latest"
  location=$(awk 'tolower($1) == "location:" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); value=$0 } END { print value }' "$headers")
  expected_location="https://codeload.github.com/$REPO/legacy.zip/refs/tags/$latest"
  if [ "$location" != "$expected_location" ]; then
    echo "URL d'archive GitHub inattendue : '$location'" >&2
    exit 1
  fi
  curl -fsS --retry 3 "${auth[@]}" "$location" -o "$archive"
  unzip -tq "$archive"

  entries="$work/entries"
  unzip -Z1 "$archive" > "$entries"
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
  done < "$entries"

  expected_root="${REPO//\//-}"
  if [ -z "$archive_root" ] || [[ "$archive_root" != "$expected_root-"* ]]; then
    echo "Racine d'archive inattendue : '$archive_root'" >&2
    exit 1
  fi

  unzip -q "$archive" -d "$extracted"
  source_dir="$extracted/$archive_root"
  for required in docker-compose.yml deploy/sdp.sysusers deploy/sdp-check.service \
    deploy/sdp-deploy.service deploy/sdp-deploy.timer deploy/sdp-release-sync.service \
    deploy/sync-release.sh; do
    if [ ! -f "$source_dir/$required" ]; then
      echo "Fichier requis absent de la release $latest : $required" >&2
      exit 1
    fi
  done

  mapfile -t staged_units < <(find "$source_dir/deploy" -maxdepth 1 -type f \
    \( -name 'sdp-*.service' -o -name 'sdp-*.timer' \) -print | sort)
  if [ "${#staged_units[@]}" -eq 0 ]; then
    echo "Aucune unité sdp-*.service ou sdp-*.timer dans la release." >&2
    exit 1
  fi
  systemd-analyze verify "${staged_units[@]}"

  : > "$state/in-progress"
  chmod 0644 "$state/in-progress"
  rsync -a --delete --safe-links \
    --exclude='/.git/' --exclude='/secrets/' --exclude='/deploy/.env' \
    "$source_dir/" "$install_dir/"
  if [ -d "$install_dir/.git" ] || [ -L "$install_dir/.git" ]; then
    rm -rf -- "$install_dir/.git"
  fi
  install -m 0644 "$install_dir/deploy/sdp.sysusers" /etc/sysusers.d/sdp.conf
  systemd-sysusers

  declare -A desired=()
  for source_unit in "$install_dir"/deploy/sdp-*.service "$install_dir"/deploy/sdp-*.timer; do
    [ -f "$source_unit" ] || continue
    unit=$(basename "$source_unit")
    if ! [[ "$unit" =~ ^sdp-[A-Za-z0-9_.@-]+\.(service|timer)$ ]]; then
      echo "Nom d'unité non autorisé : '$unit'" >&2
      exit 1
    fi
    desired["$unit"]=1
  done

  for installed_unit in "$unit_dir"/sdp-*.service "$unit_dir"/sdp-*.timer; do
    [ -e "$installed_unit" ] || [ -L "$installed_unit" ] || continue
    unit=$(basename "$installed_unit")
    if [ -z "${desired[$unit]:-}" ]; then
      if systemctl is-active --quiet "$unit"; then
        systemctl stop "$unit"
      fi
      if systemctl is-enabled --quiet "$unit"; then
        systemctl disable "$unit"
      fi
      rm -f "$installed_unit"
    fi
  done

  for source_unit in "$install_dir"/deploy/sdp-*.service "$install_dir"/deploy/sdp-*.timer; do
    [ -f "$source_unit" ] || continue
    install -m 0644 "$source_unit" "$unit_dir/$(basename "$source_unit")"
  done
  systemd-analyze verify "$unit_dir"/sdp-*.service "$unit_dir"/sdp-*.timer
  systemctl daemon-reload

  for source_unit in "$install_dir"/deploy/sdp-*.timer; do
    [ -f "$source_unit" ] || continue
    unit=$(basename "$source_unit")
    if grep -q '^[[:space:]]*\[Install\][[:space:]]*$' "$source_unit"; then
      systemctl enable "$unit"
      if systemctl is-active --quiet "$unit"; then
        systemctl restart "$unit"
      else
        systemctl start "$unit"
      fi
    fi
  done

  for source_unit in "$install_dir"/deploy/sdp-*.service; do
    [ -f "$source_unit" ] || continue
    unit=$(basename "$source_unit")
    if grep -q '^[[:space:]]*\[Install\][[:space:]]*$' "$source_unit"; then
      systemctl enable "$unit"
      if [ "$unit" != sdp-release-sync.service ] && [ "$unit" != sdp-deploy.service ]; then
        if systemctl is-active --quiet "$unit"; then
          systemctl restart "$unit"
        else
          systemctl start "$unit"
        fi
      fi
    fi
  done

  install -m 0755 "$install_dir/deploy/sync-release.sh" "$libexec_dir/sdp-release-sync"
  printf '%s\n' "$latest" > "$state/source-tag.new"
  chmod 0644 "$state/source-tag.new"
  mv "$state/source-tag.new" "$state/source-tag"
  rm -f "$state/in-progress"
  echo "Sources et unités systemd synchronisées depuis la release $latest."
fi

if [ -e "$state/in-progress" ]; then
  rm -f "$state/in-progress"
fi
flock -u 9
exec 9>&-
systemctl start sdp-deploy.service
echo "Déploiement vérifié avec les sources de la release $latest."
