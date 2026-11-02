FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

RUN apk add --no-cache openssl \
 # uid 1000 = utilisateur node de l'application, seul à devoir lire la clé
 && adduser -D -H -u 1000 tls \
 && install -d -o tls -g tls -m 0755 /tls

COPY gen-cert.sh /usr/local/bin/gen-cert

USER tls
ENTRYPOINT ["/usr/local/bin/gen-cert"]
