# Architecture

## Découpage

| Module                       | Rôle                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `backend/src/app.js`         | API REST Express : validation zod (`schemas.js`), erreurs normalisées `{error:{code,message}}`, auth, rate limit  |
| `backend/src/engine.js`      | Worker de polling : sync de chaque compte actif → règles BE / TP-SL → copy trading → re-sync des comptes modifiés |
| `backend/src/rules/*`        | Moteur de règles : fonctions **pures** (pas d'I/O), faciles à tester                                              |
| `backend/src/mt5/*`          | Interface `Mt5Provider`, implémentations `mock` et `bridge`, `ProviderManager` (cache, timeout, retries)          |
| `backend/src/store.js`       | Seul module SQL (SQLite via `node:sqlite`) ; `migrations/*.sql` appliquées au démarrage                           |
| `backend/src/secretStore.js` | Interface `encrypt/decrypt` + implémentation locale AES-256-GCM                                                   |
| `frontend/`                  | SPA vanilla JS (Vite), routage par hash (compatible GitHub Pages)                                                 |

## Choix

- **Polling plutôt qu'événementiel** : plus simple et fiable pour un MVP ; le moteur est protégé contre les ticks concurrents. Le snapshot (positions/ordres/infos) est stocké en base et sert le dashboard.
- **Node ≥ 22 + `node:sqlite`** : zéro dépendance native, migrations SQL versionnées (`schema_migrations`).
- **Vanilla JS + Vite** : le dashboard est petit ; pas de framework pour rester simple. Toute donnée affichée est échappée (`esc`).
- **Isolation MT5** : le package Python MetaTrader5 est Windows-only. Le backend parle donc à une interface `Mt5Provider`; `bridge` appelle un service HTTP à côté du terminal (implémentation de référence : `bridge/app.py`, FastAPI + MetaTrader5) :
  `POST /accounts/:login/connect|disconnect`, `GET /accounts/:login/info|positions|orders|history?days=|symbols/:s`, `POST /accounts/:login/orders`, `POST /accounts/:login/positions/:ticket/modify|close` (JSON, en-tête `Authorization` de type Bearer si `MT5_BRIDGE_TOKEN` est défini).
- **Fiabilité** : chaque appel provider a un timeout et des retries (erreurs `transient` uniquement). `placeOrder` n'est jamais rejoué automatiquement.

## Garde-fous

- **Dry-run** (défaut ON) : les règles et copies ne sont que journalisées (une fois par cooldown / par trade).
- **Kill switch** : le worker continue de synchroniser mais n'exécute plus aucune automatisation.
- **Cooldown BE** : table `rule_cooldowns` (compte, ticket, règle), posé aussi en cas d'échec pour éviter le spam.
- **TP/SL auto** : n'écrase jamais un SL/TP existant sauf `overwrite=true` ; ignore un niveau qui serait du mauvais côté du prix courant.

## Copy trading

- Idempotence : `copy_map` a une contrainte `UNIQUE(source_account, source_ticket, dest_account)`; le « claim » est inséré avant l'envoi de l'ordre. Un échec n'est donc pas rejoué automatiquement (pas de doublon possible).
- Anti-boucle : (1) les positions copiées portent `magic=987654` et un commentaire `mt5bot-copy:<ticket>` et ne sont jamais re-copiées ; (2) la création d'une relation qui formerait un cycle est refusée (409).
- La fermeture d'un trade source ferme sa copie.

## Authentification

Mot de passe unique (`APP_PASSWORD`, comparé en temps constant) → token HMAC avec expiration. Le middleware `requireAuth` est isolé dans `auth.js` pour être remplacé par une vraie solution (OIDC, JWT utilisateurs).

## Schéma

`accounts`, `snapshots`, `rule_configs` (global si `account_id` NULL, surcharge par compte), `copy_links`, `copy_map`, `rule_cooldowns`, `settings`, `events` (journal avec `correlation_id`).
