FROM mysql:9.7.2@sha256:e2bde46db6563855d7177adb5f0b57b9dc663f5a20927a90f4259d3312068497

# MySQL Shell et gosu ne servent pas au serveur et embarquent des vulnérabilités
RUN rpm -e mysql-shell && rm -f /usr/local/bin/gosu

COPY init.sql /docker-entrypoint-initdb.d/

# Lancé directement en mysql : l'entrypoint n'a plus besoin de gosu pour quitter root
USER mysql
# Pendant l'initialisation, MySQL n'écoute pas en TCP : le conteneur n'est sain qu'une fois prêt
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD mysqladmin ping -h 127.0.0.1 --silent || exit 1
