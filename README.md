# my-mt5-bot

Service de trading MT5 avec dashboard web : multi-comptes, copy trading, break-even (BE) automatique, TP/SL automatiques, kill switch et dry-run. Le frontend est un site statique déployable sur GitHub Pages ; le backend est un service Node séparé.

## Architecture

```
frontend (Vite, statique)  --HTTPS/JSON-->  backend API (Express)  --- SQLite (migrations)
  GitHub Pages                                   |  \-- secret store (AES-256-GCM)
                                                 |
                                         Engine / worker (polling)
                                                 |   rules/ (BE, TP-SL auto, copy : fonctions pures)
                                          ProviderManager (timeout + retries)
                                                 |
                               Mt5Provider : mock (simulateur) | bridge (HTTP vers terminal MT5)
```

Détails et choix : [docs/architecture.md](docs/architecture.md).

## Prérequis

- Node.js >= 22.13 (utilise `node:sqlite`) et npm.
- Pour un vrai MT5 : un terminal MT5 (Windows) et un « bridge » HTTP (voir docs). Sans cela, utiliser le provider `mock`.

## Installation et lancement local

```bash
npm install
cp backend/.env.example backend/.env      # puis renseigner APP_PASSWORD et SESSION_SECRET
cp frontend/.env.example frontend/.env
```

Le backend ne lit pas `.env` automatiquement : exportez les variables ou utilisez `node --env-file=backend/.env`.

```bash
# backend + worker embarqué (EMBED_WORKER=true par défaut), http://localhost:4000
cd backend && node --env-file=.env --disable-warning=ExperimentalWarning src/server.js

# frontend (dev), http://localhost:5173
npm run dev:frontend

# worker seul (EMBED_WORKER=false côté API ; pour le provider bridge uniquement)
cd backend && node --env-file=.env --disable-warning=ExperimentalWarning src/worker.js
```

Les migrations sont appliquées automatiquement au démarrage (`npm run migrate -w backend` pour les lancer seules).

Qualité : `npm run lint`, `npm run format:check`, `npm test`, `npm run build`.

## Configuration

Toutes les variables sont documentées dans [`backend/.env.example`](backend/.env.example).

- **Mot de passe de l'interface** : `APP_PASSWORD` (obligatoire, jamais codé en dur — le serveur refuse de démarrer sans) et `SESSION_SECRET` (>= 16 caractères, `openssl rand -hex 32`). Le login renvoie un token signé (HMAC-SHA256) valable `SESSION_TTL_SEC`; tous les endpoints `/api` sauf `/api/health` et `/api/auth/login` exigent l'en-tête HTTP `Authorization` de type Bearer (token obtenu au login). Le frontend affiche un écran de login et ne rend aucune page sans token (stocké en `sessionStorage`).
- **MT5 / mock** : à la création d'un compte, choisir le provider `mock` (simulateur local, aucun MT5 requis ; un login `fail` simule des identifiants refusés, `flaky` une première connexion instable) ou `bridge` (nécessite `MT5_BRIDGE_URL`). Le mock étant en mémoire, gardez `EMBED_WORKER=true` avec lui.
- **Secrets MT5** : chiffrés au repos (AES-256-GCM) via `SECRET_KEY` (ou un fichier de clé généré dans `data/secret.key`, `chmod 600`). Ils ne sont jamais renvoyés par l'API.
- **Garde-fous** : `dryRun` (activé par défaut : les règles et le copy trading sont seulement journalisés) et `killSwitch` (suspend toutes les automatisations) sont modifiables depuis le dashboard. Les actions manuelles restent possibles.

## Déploiement GitHub Pages

1. Déployez le backend sur un hôte accessible en HTTPS (GitHub Pages ne peut pas l'héberger). Définissez `CORS_ORIGINS=https://<utilisateur>.github.io`.
2. Dans le dépôt : _Settings → Pages → Source : GitHub Actions_.
3. _Settings → Secrets and variables → Actions → Variables_ : créez `API_URL` = URL publique du backend.
4. Poussez sur `main` : le workflow `.github/workflows/pages.yml` construit le frontend (`VITE_BASE=/<nom-du-dépôt>/`, routage par hash donc compatible Pages) et le publie.

L'URL de l'API peut aussi être modifiée sur l'écran de login. Limites : le site statique est public (le mot de passe protège l'usage de l'API, pas le téléchargement du JS) ; le backend doit être hébergé séparément.

## Sécurité (MVP)

- Mot de passe unique partagé, session = token signé sans révocation côté serveur (expire seul). Limitation de débit sur le login et les actions critiques (en mémoire, par IP).
- Servez toujours le backend en HTTPS. Ne jamais exposer le port 4000 sans reverse proxy TLS.
- Production : remplacer par une vraie authentification (OIDC/comptes utilisateurs, 2FA, rôles/permissions, révocation de sessions), un secret store dédié (KMS/Vault), un rate limiting partagé (Redis) et utiliser des comptes MT5 « investor »/démo pour tester.

## Fonctionnalités : état

| Fonctionnalité                                                                                                                                                    | État                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| CRUD comptes, activation, santé/statut, multi-comptes                                                                                                             | ✅                                                                                              |
| Positions, ordres, historique, close total/partiel, modify SL/TP, move to BE                                                                                      | ✅                                                                                              |
| Règle BE (points/pips/argent, offset, filtres symbole/magic/commentaire, cooldown), global + par compte                                                           | ✅                                                                                              |
| Auto TP/SL (distance pips/points, % risque, filtres symbole/magic/session, sans écrasement par défaut)                                                            | ✅                                                                                              |
| Copy trading (ratio, min/max lot, filtre symboles, inverse, idempotence, anti-boucle, logs)                                                                       | ✅                                                                                              |
| Dry-run, kill switch, rate limiting, logs structurés + corrélation, événements en base                                                                            | ✅                                                                                              |
| Persistance SQLite + migrations, chiffrement des secrets                                                                                                          | ✅                                                                                              |
| Dashboard (vue d'ensemble, comptes, trades, copy, règles, logs) + login                                                                                           | ✅ (polling 5 s, pas de websocket)                                                              |
| Provider MT5 réel                                                                                                                                                 | ⚠️ client HTTP « bridge » fourni, bridge lui-même non fourni, non testé contre un vrai terminal |
| Permissions fines par action / multi-utilisateurs                                                                                                                 | ❌                                                                                              |
| Copy trading : modifications SL/TP et fermetures partielles de la source non répliquées ; copies en échec non rejouées (volontairement, pour éviter les doublons) | ⚠️                                                                                              |

Roadmap : bridge MT5 de référence, websocket/SSE, auth réelle + rôles, répliquer les modifications SL/TP, trailing stop, notifications (Telegram/email), tests e2e frontend, mapping de symboles entre brokers.
