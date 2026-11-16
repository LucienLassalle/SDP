FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

RUN apk add --no-cache openssl \
 # uid 1000 = utilisateur node de l'application, seul à devoir lire la clé
 && adduser -D -H -u 1000 tls \
 && install -d -o tls -g tls -m 0755 /tls

COPY gen-cert.sh /usr/local/bin/gen-cert

USER tls
ENTRYPOINT ["/usr/local/bin/gen-cert"]
