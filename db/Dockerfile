FROM mysql:9.7.2@sha256:e2bde46db6563855d7177adb5f0b57b9dc663f5a20927a90f4259d3312068497

# MySQL Shell et gosu ne servent pas au serveur et embarquent des vulnérabilités
RUN rpm -e mysql-shell && rm -f /usr/local/bin/gosu

COPY init.sql /docker-entrypoint-initdb.d/

# Lancé directement en mysql : l'entrypoint n'a plus besoin de gosu pour quitter root
USER mysql
