# SDP

## Démarrage

```bash
docker compose up --build
```

## Analyse Semgrep

Le workflow GitHub Actions `Semgrep` analyse le code à chaque push et pull request,
et peut également être lancé manuellement depuis l'onglet Actions. Il utilise les
règles détectées automatiquement par Semgrep (`--config auto`) et publie le rapport
SARIF comme artefact de l'exécution. Les alertes sont aussi affichées dans les logs
avec la règle, la sévérité, le fichier, la ligne et le détail du problème.

L'option `--error` fait échouer l'étape et bloque la validation de la PR dès qu'une
alerte est détectée. Les erreurs d'installation ou d'exécution de Semgrep font
également échouer l'analyse.

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
