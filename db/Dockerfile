FROM mysql:26.7.0@sha256:9d48c42f8341068f199116dfccb919b607c99765b5c61e549a548a43033471a4

# MySQL Shell et gosu ne servent pas au serveur et embarquent des vulnérabilités
RUN rpm -e mysql-shell && rm -f /usr/local/bin/gosu

COPY init.sql /docker-entrypoint-initdb.d/

# Lancé directement en mysql : l'entrypoint n'a plus besoin de gosu pour quitter root
USER mysql
# Pendant l'initialisation, MySQL n'écoute pas en TCP : le conteneur n'est sain qu'une fois prêt
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD ["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
