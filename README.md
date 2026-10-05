# SDP

## Démarrage

```bash
docker compose up --build
```

## Analyse Semgrep

Le workflow GitHub Actions `Semgrep` analyse le code à chaque push et pull request,
et peut également être lancé manuellement depuis l'onglet Actions. Il utilise les
règles détectées automatiquement par Semgrep (`--config auto`) et publie le rapport
SARIF comme artefact de l'exécution.

Les résultats ne font pas échouer le workflow : ce projet contient volontairement
des vulnérabilités à des fins pédagogiques. Les erreurs d'installation ou d'exécution
de Semgrep, en revanche, font échouer l'étape d'analyse.