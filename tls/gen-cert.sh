#!/bin/sh
# Crée le certificat autosigné de l'application dans /tls s'il est absent ou expire dans moins de 30 jours
set -eu

dir=/tls
san="${TLS_SAN:-DNS:localhost,IP:127.0.0.1}"

if [ -f "$dir/cert.pem" ] && openssl x509 -checkend 2592000 -noout -in "$dir/cert.pem" >/dev/null; then
  echo "Certificat valide, rien à faire"
  exit 0
fi

umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 \
  -subj "/CN=sdp" -addext "subjectAltName=$san" \
  -keyout "$dir/key.pem.new" -out "$dir/cert.pem.new" 2>/dev/null
chmod 0400 "$dir/key.pem.new"
chmod 0444 "$dir/cert.pem.new"
mv -f "$dir/key.pem.new" "$dir/key.pem"
mv -f "$dir/cert.pem.new" "$dir/cert.pem"
echo "Certificat créé ($san), valable 365 jours"
