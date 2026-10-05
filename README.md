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
