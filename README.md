# SDP

## Démarrage

```bash
install -d -m 0700 secrets
(umask 022 && openssl rand -hex 32 > secrets/db_password)
SESSION_SECRET=<secret> docker compose up -d --build
```

Le site est servi en HTTPS uniquement : https://localhost (port `HTTPS_PORT`, 443 par défaut). Il n'écoute que
sur `127.0.0.1` : pour l'exposer, définir `HTTPS_BIND` (IP de l'interface publique, ou `0.0.0.0`).

L'application se connecte à MySQL avec le compte `forum` (`SELECT` et `INSERT` sur la base `forum`, `UPDATE` sur la
seule colonne `users.password`).
Son mot de passe est lu dans `secrets/db_password`, ignoré par git (ou dans le fichier indiqué par
`DB_PASSWORD_FILE`), et monté en lecture seule dans `/run/secrets` de l'application et de MySQL : il n'apparaît ni dans
l'environnement des conteneurs ni dans `docker inspect`. Le fichier doit être lisible par les utilisateurs des
conteneurs (0644), c'est son dossier (0700) qui le protège sur l'hôte. Le mot de passe root est aléatoire et
n'est pas utilisé. Un volume `db-data` créé avant ce changement ne contient pas ce compte : le recréer
(`docker compose down -v`).

Le forum démarre sans compte ni message. Chacun crée son compte sur `/register` et peut changer son mot de passe
sur `/password` ; les mots de passe sont hachés avec scrypt. Si la base ne contient aucun compte au démarrage,
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

1. En parallèle, sans rien construire :
   - **Semgrep scan** : analyse du code avec les règles automatiques de Semgrep
     (`--config auto --error`), rapport SARIF publié comme artefact. La moindre alerte bloque la PR ;
   - **Lint** (`pytest -m lint` de SDP-Tests) : ESLint sur le JavaScript, hadolint sur les `Dockerfile`,
     ShellCheck sur les scripts et actionlint sur les workflows.
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

Toutes les 30 minutes, et 30 secondes après le démarrage, le timer `sdp-deploy.timer` vérifie la dernière release publiée. La VM télécharge son archive ZIP GitHub, synchronise le code et les unités systemd de cette release, puis récupère ses images depuis GHCR. Le code source et les images sont ainsi toujours épinglés au même tag de release, sans `git pull`. Si les conteneurs ne deviennent pas sains (healthchecks), elle revient à la version précédente et ne retente pas la version défaillante.

GitHub n'a aucun accès au serveur : c'est le serveur qui vient chercher les releases.

Trois services, dont deux avec un utilisateur système (`deploy/sdp.sysusers`) :

| Service | Script | Accès |
|---------|--------|-------|
| `sdp-check` | `deploy/check.sh` | Interroge l'API GitHub, écrit le tag dans `/var/lib/sdp-check/latest-tag`. Réseau limité à l'API GitHub et à localhost, aucun accès à Docker |
| `sdp-release-sync` | `deploy/sync-release.sh` | Télécharge l'archive de la release, synchronise `/opt/sdp` et installe les unités `sdp-*`. Tourne en root pour pouvoir modifier `/etc/systemd/system`; sandboxé par systemd |
| `sdp-deploy` | `deploy/deploy.sh` | Déploie l'image du tag synchronisé. Aucun réseau ; groupe `docker` pour Docker et groupe `sdp-deploy` pour le seul fichier de verrou |

Le timer lance `sdp-release-sync`, qui démarre d'abord `sdp-check`, puis déclenche `sdp-deploy`. Les services de
vérification et de déploiement tournent dans leur propre espace utilisateurs, sans capability.
Les nouveaux fichiers `sdp-*.service` et `sdp-*.timer` de la release sont installés automatiquement. Les unités
dotées d'une section `[Install]` sont activées ; les timers déjà actifs sont redémarrés pour prendre immédiatement
en compte leur nouvelle fréquence. La synchronisation retire aussi les anciennes unités `sdp-*` absentes de la
release. Les fichiers `sdp-*` des releases sont donc du code privilégié : ils ne sont appliqués qu'après la
publication contrôlée de la release.

Prérequis :
- le groupe `docker` existe et `docker compose` est installé dans un dossier système (`/usr/lib*/docker/cli-plugins`) ;
- la résolution DNS passe par systemd-resolved (`127.0.0.53`) : `sdp-check` ne peut joindre que localhost et l'API GitHub ;
- l'archive source est téléchargée depuis `codeload.github.com` par le service de synchronisation ;
- les plages IP de l'API GitHub sont dans `IPAddressAllow=` de `deploy/sdp-check.service`. Si GitHub les change
  (https://api.github.com/meta, clé `api`), les mettre à jour.

Installation automatisée (une seule fois, en root, sur Debian 13 ou compatible) :

```bash
sudo apt-get update && sudo apt-get install -y curl
curl -fsSL https://raw.githubusercontent.com/LucienLassalle/SDP/main/deploy/bootstrap.sh \
  | sudo env TLS_SAN=DNS:localhost,IP:127.0.0.1,IP:192.168.1.118 bash
```

La fonctionnalité de synchronisation doit d'abord être incluse dans une release publiée. La VM ne récupère pas
les modifications de `main` directement : elle applique uniquement le code et les images de la dernière release.
Après publication de cette release, exécuter le bootstrap ci-dessus une fois sur la VM déjà installée pour activer
le nouveau timer et synchroniser immédiatement les fichiers.

Adapter `TLS_SAN` à l'adresse ou au nom utilisé pour accéder au serveur. Le script télécharge l'archive ZIP de la
dernière release, installe Docker, Compose et `systemd-resolved`, crée les secrets seulement s'ils n'existent pas,
installe les services, active le timer et déclenche le premier déploiement. Il reprend le résolveur DHCP courant ;
si nécessaire, le préciser avec `DNS_SERVER=192.168.1.254`.

Relancer le bootstrap met à jour la VM vers l'archive de la dernière release. Pour une image ou un dépôt privé,
fournir `GH_TOKEN` et `GH_USER` dans l'environnement du bootstrap ; le token doit avoir `read:packages` et
`contents:read` si le dépôt est privé. Les secrets applicatifs et le fichier `.env` restent locaux à la VM et ne
sont pas remplacés par les archives.

Le tag des sources synchronisées est enregistré dans `/var/lib/sdp-release-sync/source-tag` ; le tag utilisé
pour les images est dans `/var/lib/sdp-deploy/.current-tag`. Ils sont identiques après un cycle réussi. Un
verrou partagé empêche une synchronisation de modifier le code pendant qu'un déploiement l'utilise. Si une
synchronisation est interrompue en cours, le déploiement reste suspendu jusqu'à la prochaine synchronisation
réussie. Les digests SHA-256 des trois images sont consignés dans `/var/lib/sdp-deploy/.current-digests` et
revérifiés à chaque cycle ; ils apparaissent dans le journal du service de déploiement.
Suivre un cycle avec `journalctl -u sdp-check -u sdp-release-sync -u sdp-deploy`.

Depuis l'ancien service `sdp-update` : `systemctl disable --now sdp-update.timer`, puis supprimer
`/etc/systemd/system/sdp-update.*` avant l'installation ci-dessus.

Pour configurer les identifiants d'un dépôt ou d'images privés après l'installation :

```bash
sudoedit /opt/sdp/deploy/.env
```

Ajouter sans effacer les variables existantes :

```dotenv
GH_TOKEN=<token>
GH_USER=<utilisateur du token>
```

Version d'image en ligne : `cat /var/lib/sdp-deploy/.current-tag`
