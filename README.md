# SDP

## Démarrage

```bash
docker compose up --build
```

## CI

Le workflow `CI` (`.github/workflows/ci.yml`) tourne sur chaque pull request, sur `main`
et à la demande. Chaque étape ne démarre que si la précédente a réussi :

1. **Semgrep scan** : analyse du code avec les règles automatiques de Semgrep
   (`--config auto --error`), rapport SARIF publié comme artefact. La moindre alerte bloque la PR.
2. **Tests**, sur la VM jetable fournie par GitHub, avec les tests de
   [SDP-Tests](https://github.com/LucienLassalle/SDP-Tests) :
   1. construction des images Docker du compose (application et base de données) ;
   2. analyses statiques (`pytest -m static`) : Trivy sur le code et sur chaque image
      (vulnérabilités, secrets, mauvaises configurations), KICS sur `docker-compose.yml`
      et `systemd-analyze security` sur `deploy/*.service`. Si elles échouent,
      l'application n'est pas déployée ;
   3. démarrage de l'application avec `docker compose` ;
   4. tests fonctionnels (`pytest -m functional`) ;
   5. arrêt de l'application (la VM est de toute façon détruite).

SDP-Tests est pour l'instant pris sur sa branche `main` (`SDP_TESTS_REF` dans le workflow,
un avertissement le rappelle à chaque exécution). À terme, la CI utilisera une release fixe
de SDP-Tests.

## Base de données

`db/Dockerfile` construit l'image MySQL à partir de l'image officielle `mysql` (LTS, épinglée par digest) :
MySQL Shell et `gosu`, inutiles au serveur et vulnérables, sont retirés, `db/init.sql` est embarqué et
MySQL tourne directement en utilisateur `mysql`.

`init.sql` ne s'exécute qu'à la création du volume `db-data`. Un volume créé par MySQL 5.6 ne peut pas
être repris par MySQL 9 : il faut le supprimer (`docker compose down -v`) ou migrer les données.

## Release

À chaque release publiée (tag `vX.Y.Z` ou `vX.Y.Z-suffixe`, ex. `v0.0.2-beta`), le workflow `Release` (`.github/workflows/release.yml`) :

1. vérifie le format du tag et que son commit est bien sur `main` ;
2. construit les images Docker et les publie sur GHCR : l'application
   (`ghcr.io/<owner>/<repo>:<version>`) et la base de données (`ghcr.io/<owner>/<repo>-db:<version>`) ;
3. génère les SBOM SPDX du code et de l'image de l'application pour cette version.

Les releases cochées "pre-release" sur GitHub ne sont pas publiées, quel que soit leur tag.

## Déploiement sur le serveur

Le serveur vérifie chaque heure s'il existe une nouvelle release (`deploy/update.sh`, lancé par un timer systemd). Si c'est le cas, il récupère les images correspondantes sur GHCR et remplace l'ancienne version avec le `docker-compose.yml` du dépôt (`image` = version publiée, `build` = construction locale pour le développement). Si la nouvelle version ne répond pas, il revient automatiquement à la précédente et ne retente pas la version défaillante.

GitHub n'a aucun accès au serveur : c'est le serveur qui vient chercher les releases.

Installation (une seule fois, en root, sur une machine avec Docker) :

```bash
git clone https://github.com/LucienLassalle/SDP.git /opt/sdp
cp /opt/sdp/deploy/sdp-update.service /opt/sdp/deploy/sdp-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sdp-update.timer
```

Le service ne tourne pas en root : systemd crée à chaque lancement un utilisateur éphémère, seulement
membre du groupe `docker` (qui doit exister). Ses fichiers (versions déployées, identifiants GHCR) sont
dans `/var/lib/sdp`, et `/opt/sdp` lui est en lecture seule. Le groupe `docker` donne un accès équivalent
à root via Docker : c'est le seul privilège du service.

Si le dépôt ou les images sont privés, créer un token GitHub en lecture (`read:packages`, et `contents:read`
si le dépôt est privé). Le service se connecte lui-même à GHCR avec :

```bash
install -m 600 /dev/null /opt/sdp/deploy/.env
echo "GH_TOKEN=<token>" >> /opt/sdp/deploy/.env
echo "GH_USER=<utilisateur du token>" >> /opt/sdp/deploy/.env
```

Suivi : `journalctl -u sdp-update -f` · version en ligne : `cat /var/lib/sdp/.current-tag`
