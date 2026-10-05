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
   1. construction de l'image Docker ;
   2. analyses statiques (`pytest -m static`) : Trivy sur le code et l'image
      (vulnérabilités, secrets, mauvaises configurations) et `systemd-analyze security`
      sur `deploy/*.service`. Si elles échouent, l'application n'est pas déployée ;
   3. démarrage de l'application avec `docker compose` ;
   4. tests fonctionnels (`pytest -m functional`) ;
   5. arrêt de l'application (la VM est de toute façon détruite).

SDP-Tests est pour l'instant pris sur sa branche `main` (`SDP_TESTS_REF` dans le workflow,
un avertissement le rappelle à chaque exécution). À terme, la CI utilisera une release fixe
de SDP-Tests.

## Release

À chaque release publiée (tag `vX.Y.Z` ou `vX.Y.Z-suffixe`, ex. `v0.0.2-beta`), le workflow `Release` (`.github/workflows/release.yml`) :

1. vérifie le format du tag et que son commit est bien sur `main` ;
2. construit l'image Docker et la publie sur GHCR (`ghcr.io/<owner>/<repo>:<version>`) ;
3. génère les SBOM SPDX du code et de l'image pour cette version.

Les releases cochées « pre-release » sur GitHub ne sont pas publiées, quel que soit leur tag.

## Déploiement sur le serveur

Le serveur vérifie chaque heure s'il existe une nouvelle release (`deploy/update.sh`, lancé par un timer systemd). Si c'est le cas, il récupère l'image correspondante sur GHCR et remplace l'ancienne version avec le `docker-compose.yml` du dépôt (`image` = version publiée, `build` = construction locale pour le développement). Si la nouvelle version ne répond pas, il revient automatiquement à la précédente et ne retente pas la version défaillante.

GitHub n'a aucun accès au serveur : c'est le serveur qui vient chercher les releases.

Installation (une seule fois, en root, sur une machine avec Docker) :

```bash
git clone https://github.com/LucienLassalle/SDP.git /opt/sdp
cp /opt/sdp/deploy/sdp-update.service /opt/sdp/deploy/sdp-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sdp-update.timer
```

Si le dépôt ou l'image sont privés, créer un token GitHub en lecture (`read:packages`, et `contents:read` si le dépôt est privé) puis :

```bash
echo "GH_TOKEN=<token>" > /opt/sdp/deploy/.env
echo "<token>" | docker login ghcr.io -u <utilisateur> --password-stdin
```

Suivi : `journalctl -u sdp-update -f` · version en ligne : `cat /opt/sdp/deploy/.current-tag`
