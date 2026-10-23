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

## Connecter un vrai compte MT5 (bridge de référence)

Le « bridge » est un petit service Python ([`bridge/`](bridge/app.py)) qui s'exécute **sur la machine Windows où est installé le terminal MetaTrader 5** (le paquet Python `MetaTrader5` n'existe que sous Windows). Le backend lui envoie des requêtes HTTP ; il les traduit en appels au terminal. Un terminal ne gère qu'un compte à la fois : le bridge sérialise les requêtes, donc pour piloter plusieurs comptes réels simultanément, lancez un terminal/bridge par compte (ou acceptez le basculement).

1. Installez MetaTrader 5, connectez-vous une fois manuellement à votre broker, et activez _Outils → Options → Expert Advisors → Autoriser le trading algorithmique_.
2. Installez Python 3.10+ (64 bits) puis :
   ```
   cd bridge
   pip install -r requirements.txt
   set BRIDGE_TOKEN=<openssl rand -hex 32>
   python app.py
   ```
   Le bridge écoute sur `127.0.0.1:8765` (`BRIDGE_HOST` / `BRIDGE_PORT`). Il refuse de répondre sans `BRIDGE_TOKEN`.
3. Backend : `MT5_BRIDGE_URL=http://127.0.0.1:8765` et `MT5_BRIDGE_TOKEN=<même token>`. Si le backend est sur une autre machine, exposez le bridge uniquement via un tunnel/VPN ou reverse proxy HTTPS (ne l'ouvrez jamais publiquement).
4. Dashboard → Comptes MT5 → provider **bridge**, avec le login numérique, le **nom exact du serveur** du broker et le mot de passe du compte (idéalement d'abord un compte démo ou le mot de passe investor pour du lecture seule). Le statut passe à « connected » après la prochaine synchro (5 s) ; en cas d'erreur, elle est affichée dans la colonne « Erreur ».

Tests du bridge (sans MT5, avec un faux module) : `cd bridge && pip install fastapi httpx pytest && pytest`.
Le bridge n'a pas pu être validé contre un vrai terminal MT5 dans l'environnement de développement : testez d'abord sur un compte démo.

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

| Fonctionnalité                                                                                                                                                    | État                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CRUD comptes, activation, santé/statut, multi-comptes                                                                                                             | ✅                                                                                                                      |
| Positions, ordres, historique, close total/partiel, modify SL/TP, move to BE                                                                                      | ✅                                                                                                                      |
| Règle BE (points/pips/argent, offset, filtres symbole/magic/commentaire, cooldown), global + par compte                                                           | ✅                                                                                                                      |
| Auto TP/SL (distance pips/points, % risque, filtres symbole/magic/session, sans écrasement par défaut)                                                            | ✅                                                                                                                      |
| Copy trading (ratio, min/max lot, filtre symboles, inverse, idempotence, anti-boucle, logs)                                                                       | ✅                                                                                                                      |
| Dry-run, kill switch, rate limiting, logs structurés + corrélation, événements en base                                                                            | ✅                                                                                                                      |
| Persistance SQLite + migrations, chiffrement des secrets                                                                                                          | ✅                                                                                                                      |
| Dashboard (vue d'ensemble, comptes, trades, copy, règles, logs) + login                                                                                           | ✅ (polling 5 s, pas de websocket)                                                                                      |
| Provider MT5 réel                                                                                                                                                 | ⚠️ client + bridge de référence fournis (`bridge/`), testés avec un faux module uniquement, pas contre un vrai terminal |
| Permissions fines par action / multi-utilisateurs                                                                                                                 | ❌                                                                                                                      |
| Copy trading : modifications SL/TP et fermetures partielles de la source non répliquées ; copies en échec non rejouées (volontairement, pour éviter les doublons) | ⚠️                                                                                                                      |

Roadmap : websocket/SSE, auth réelle + rôles, répliquer les modifications SL/TP, trailing stop, notifications (Telegram/email), tests e2e frontend, mapping de symboles entre brokers.
