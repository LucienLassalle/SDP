FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache openssl \
 # uid 1000 = utilisateur node de l'application, seul à devoir lire la clé
 && adduser -D -H -u 1000 tls \
 && install -d -o tls -g tls -m 0755 /tls

COPY gen-cert.sh /usr/local/bin/gen-cert

USER tls
ENTRYPOINT ["/usr/local/bin/gen-cert"]
