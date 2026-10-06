# SDP

## Démarrage

```bash
install -d -m 0700 secrets
(umask 022 && openssl rand -hex 32 > secrets/db_password)
SESSION_SECRET=<secret> docker compose up -d --build
```

Le site est servi en HTTPS uniquement : https://localhost (port `HTTPS_PORT`, 443 par défaut). Il n'écoute que
sur `127.0.0.1` : pour l'exposer, définir `HTTPS_BIND` (IP de l'interface publique, ou `0.0.0.0`).

L'application se connecte à MySQL avec le compte `forum` (`SELECT` et `INSERT` sur la base `forum` uniquement).
Son mot de passe est lu dans `secrets/db_password`, ignoré par git (ou dans le fichier indiqué par
`DB_PASSWORD_FILE`), et monté en lecture seule dans `/run/secrets` de l'application et de MySQL : il n'apparaît ni dans
l'environnement des conteneurs ni dans `docker inspect`. Le fichier doit être lisible par les utilisateurs des
conteneurs (0644), c'est son dossier (0700) qui le protège sur l'hôte. Le mot de passe root est aléatoire et
n'est pas utilisé. Un volume `db-data` créé avant ce changement ne contient pas ce compte : le recréer
(`docker compose down -v`).

Le forum démarre sans compte ni message. Chacun crée son compte sur `/register` ; les mots de passe sont hachés
avec scrypt. Si la base ne contient aucun compte au démarrage,
l'application crée un compte `admin` avec un mot de passe aléatoire, affiché une seule fois dans ses logs :

```bash
docker compose logs web | grep -A 2 'compte administrateur'
```

Ce mot de passe reste lisible dans les logs du conteneur : le changer après la première connexion.

Au démarrage, le service `tls` (`tls/Dockerfile`, Alpine + openssl) crée un certificat autosigné dans le volume
`tls` s'il manque ou expire dans moins de 30 jours, puis s'arrête. L'application le lit en lecture seule ; la clé
n'est jamais dans une image ni dans le dépôt. Le certificat couvre `localhost` et `127.0.0.1` : pour un autre nom,
définir `TLS_SAN` (ex. `TLS_SAN=DNS:sdp.example.org,IP:192.0.2.10`) et supprimer le volume `tls` pour le régénérer.
Le navigateur affiche un avertissement, normal pour un certificat autosigné.

## CI

Le workflow `CI` (`.github/workflows/ci.yml`) tourne sur chaque pull request, sur `main`
et à la demande. Chaque étape ne démarre que si la précédente a réussi :

1. **Semgrep scan** : analyse du code avec les règles automatiques de Semgrep
   (`--config auto --error`), rapport SARIF publié comme artefact. La moindre alerte bloque la PR.
2. **Tests**, sur la VM jetable fournie par GitHub, avec les tests de
   [SDP-Tests](https://github.com/LucienLassalle/SDP-Tests) :
   1. construction des images Docker du compose (application, base de données, certificat) ;
   2. analyses statiques (`pytest -m static`) : Trivy sur le code et sur chaque image
      (vulnérabilités, secrets, mauvaises configurations), KICS sur `docker-compose.yml`
      et `systemd-analyze security` sur `deploy/*.service`. Si elles échouent,
      l'application n'est pas déployée ;
   3. démarrage de l'application avec `docker compose`, en HTTPS ;
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
   (`ghcr.io/<owner>/<repo>:<version>`), la base de données (`ghcr.io/<owner>/<repo>-db:<version>`)
   et le générateur de certificat (`ghcr.io/<owner>/<repo>-tls:<version>`) ;
3. génère les SBOM SPDX du code et de l'image de l'application pour cette version.

Les releases cochées "pre-release" sur GitHub ne sont pas publiées, quel que soit leur tag.

Seuls les admins du dépôt peuvent créer, déplacer ou supprimer un tag `v*` (ruleset « Protect release tags »).
Les jobs de publication passent par l'environnement `production` : ils attendent la validation d'un code owner
autre que l'auteur de la release, et ne tournent que pour les tags `v*`. Le workflow exécuté étant celui du
commit tagué, c'est ce qui empêche de publier une image depuis un `release.yml` modifié hors de `main`.

## Déploiement sur le serveur

Le serveur vérifie chaque heure s'il existe une nouvelle release (timer systemd `sdp-deploy.timer`). Si c'est le cas, il récupère les images correspondantes sur GHCR et remplace l'ancienne version avec le `docker-compose.yml` du dépôt (`image` = version publiée, `build` = construction locale pour le développement). Si les conteneurs ne deviennent pas sains (healthchecks), il revient automatiquement à la version précédente et ne retente pas la version défaillante.

GitHub n'a aucun accès au serveur : c'est le serveur qui vient chercher les releases.

Deux services, chacun avec son utilisateur système (`deploy/sdp.sysusers`) :

| Service | Script | Accès |
|---------|--------|-------|
| `sdp-check` | `deploy/check.sh` | Interroge l'API GitHub, écrit le tag dans `/var/lib/sdp-check/latest-tag`. Réseau limité à l'API GitHub et à localhost, aucun accès à Docker |
| `sdp-deploy` | `deploy/deploy.sh` | Lit ce tag et pilote Docker. Aucun réseau, `docker` comme seul groupe (accès équivalent à root via Docker : c'est son seul privilège) |

Le timer lance `sdp-deploy`, qui démarre d'abord `sdp-check`. Les deux tournent en lecture seule sur le
système, dans leur propre espace utilisateurs, sans capability.

Prérequis :
- le groupe `docker` existe et `docker compose` est installé dans un dossier système (`/usr/lib*/docker/cli-plugins`) ;
- la résolution DNS passe par systemd-resolved (`127.0.0.53`) : `sdp-check` ne peut joindre que localhost et l'API GitHub ;
- les plages IP de l'API GitHub sont dans `IPAddressAllow=` de `deploy/sdp-check.service`. Si GitHub les change
  (https://api.github.com/meta, clé `api`), les mettre à jour.

Installation (une seule fois, en root, sur une machine avec Docker) :

```bash
git clone https://github.com/LucienLassalle/SDP.git /opt/sdp
cp /opt/sdp/deploy/sdp.sysusers /etc/sysusers.d/sdp.conf
systemd-sysusers
cp /opt/sdp/deploy/sdp-check.service /opt/sdp/deploy/sdp-deploy.service /opt/sdp/deploy/sdp-deploy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sdp-deploy.timer
```

Depuis l'ancien service `sdp-update` : `systemctl disable --now sdp-update.timer`, puis supprimer
`/etc/systemd/system/sdp-update.*` avant l'installation ci-dessus.

Si le dépôt ou les images sont privés, créer un token GitHub en lecture (`read:packages`, et `contents:read`
si le dépôt est privé). `sdp-check` l'utilise pour l'API, `sdp-deploy` pour se connecter à GHCR :

```bash
install -m 600 /dev/null /opt/sdp/deploy/.env
echo "GH_TOKEN=<token>" >> /opt/sdp/deploy/.env
echo "GH_USER=<utilisateur du token>" >> /opt/sdp/deploy/.env
```

Suivi : `journalctl -u sdp-check -u sdp-deploy -f` · version en ligne : `cat /var/lib/sdp-deploy/.current-tag`
