FROM mysql:26.10.0@sha256:3819b2b23835c4a73c8b022fafc33c8095c0f81c929a8b7a84613d2fba6c52f5

# MySQL Shell et gosu ne servent pas au serveur et embarquent des vulnérabilités
RUN rpm -e mysql-shell && rm -f /usr/local/bin/gosu

COPY init.sql /docker-entrypoint-initdb.d/

# Lancé directement en mysql : l'entrypoint n'a plus besoin de gosu pour quitter root
USER mysql
# Pendant l'initialisation, MySQL n'écoute pas en TCP : le conteneur n'est sain qu'une fois prêt
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD ["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
