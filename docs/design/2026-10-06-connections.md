# Project 4: Connections (design)

Status: built on feat/connectors-ui. Fourth of four projects (dashboard, liabilities, smart import, **connections**). Builds on `plans/2026-10-05-smart-import-design.md` (project 3), whose section 12 reserved the connector entry point, and on the code at `86992ce` (main plus the smart import UI branch `feat/smart-import-ui`).

## 0. Goal

The request: people should be able to "connect (eventually) to other apps and import so that it can automatically categorize expenses". Project 3 built the pipeline (parse, normalize, rules and AI categorize, review, apply, undo). This project adds the "connect" half: the user links a bank data source once, then presses **Sync now** and gets the same review wizard with only the new transactions, categorized by the same rules, applied and undone the same way.

Hard constraints:

- Finlity signs up for nothing and holds no developer secret for any aggregator. What ships is (1) a provider-agnostic connector abstraction and (2) providers where **the user brings their own credential**: SimpleFIN Bridge (primary), Akahu personal apps (second, New Zealand), and a synthetic demo provider.
- Paid or developer-registered aggregators (Plaid, Teller, MX, Finicity, GoCardless/Nordigen, Basiq, an Akahu full app) are compared in section 15 and **not built**.
- Every connected pull goes through the smart import review and undo. Nothing is applied without review.

Out of scope: payments of any kind, webhooks, a server-side scheduler (section 9.3), pending transactions, investment holdings, multi-currency conversion, and editing stored transactions outside the wizard.

## 1. What exists today (verified)

### 1.1 The smart import pipeline

| Piece | Where | Relevance |
|---|---|---|
| `NormalizedStatement` contract | `src/smart_import/types.py` (TypedDicts), design 4.6 | A connector produces exactly this. `ORIGINS` already includes `connector`; `format` accepts `connector` in both Apply validators. |
| `finalize_statement(stmt, context, file_name)` | `src/smart_import/normalize.py:346` | Applies user rules then seed rules, sets `origin` from `context["origin"]`. Connectors call it, so categorization is not duplicated. |
| `mask_description`, `merchant_key`, `infer_kind`, `dedupe_base(..., fitid=)` | `normalize.py` | Reused unchanged. `dedupe_base` with a FITID hashes `"fitid|" + id`; connectors pass a provider-prefixed id. |
| `account_key_from_number` | `normalize.py:308` | Keeps **digits only**. Provider account ids are opaque strings (SimpleFIN `ACT-...`, Akahu `acc_...`), so this function would collapse every account at an institution onto one key. Connectors need their own derivation (section 5.2). |
| `WARNINGS` | `types.py` | Closed vocabulary enforced by a test; new connector codes are added there first. |
| Limits | `src/smart_import/limits.py` | `MAX_FILE_BYTES` 10 MB, `MAX_TRANSACTIONS_PER_STATEMENT` 10,000, `MAX_DESCRIPTION_CHARS` 120, PDF wall clock 20 s. Connector limits match these. |
| Errors | `src/smart_import/errors.py` | Fixed-message catalog; `str(exc)` is the fixed detail. Connectors get a sibling catalog. |
| `SmartImportRoute` | `src/api/v2/smart_import.py:101` | Route class that turns every error into `{error_type, detail}` (no exception text, no FastAPI 422 echo) and caps body size. Reused for connector routes. |
| Data layer | `src/smart_import/service.py`, `src/api/smart_import.py`, `src/web/src/database/local-smart-import.ts`, `local()` routes in `dispatcher.ts:703` | context, preview, apply, imports, undo, rules, settings, spending summary. |
| `smart_import_meta.connection_id` | `models.py:688`, `client-database.ts:811` | Column exists in both schemas. **Nothing writes it**: `ApplyStatement` is `extra="forbid"` without the field, neither `_insert_statement` (server) nor the browser insert (`local-smart-import.ts:1129`) includes it, `list_imports` does not return it. Plumbing only, no migration. |
| `merchant_rules.source` | CHECK `IN ('user','import','ai','connector')` both paths | `ApplyRule.source` already accepts `connector`. |
| `import_transactions.external_id`, `dedupe_key` (unique) | both schemas | Connector transaction ids land in `external_id`; dedupe works unchanged. |
| Wizard | `features/smart-import.ts`, `utils/smart-import-state.ts` (branch) | File-centric: `WizardFile` per upload, `mergeAnalyze(state, fileId, AnalyzeResponse)`. `WizardFile.origin` and `AnalyzeOverrides.origin` are typed `'file' \| 'sample'`. `buildApplyRequest` has no `connection_id`. `MAX_APPLY_STATEMENTS` is 12. |

### 1.2 Secrets and settings

- `src/services/secrets.py SecretsManager`: Fernet (`MultiFernet` with a legacy key) keyed from `SECRET_KEY` or `~/.investment_dashboard_key`; values stored in `app_settings` with `encrypted=1` and a `fernet:` prefix. `get_api_key(name)` checks the environment, `.env` and `config.yaml` **before** the database and returns `None` on a decrypt failure. Connector secrets must not take that path (an env var named after a connection is meaningless, and a decrypt failure must surface as "reconnect", not silence).
- `app_settings(key, value, encrypted, updated_at)` exists in both schemas (`client-database.ts:596`). `src/smart_import/settings_store.py` shows the pattern for one sanitized JSON row (`smart_import`).
- Hosted mode: `/api/settings/api-key/**` is DISABLED; hosted AI uses only the operator's env key (project 3, K3).

### 1.3 Hosted mode mechanics

- `apiCall` in local data mode tries `local()` routes, then synchronous `payload()` rewrites (`PayloadRouteHandler` returns a rewrite, it cannot `await`), then the PASSTHROUGH allowlist (`/api/v2/**` among others).
- `client.ts` already has **async composite handlers** for local mode that combine local reads, a v2 round trip and local writes (bank statement upload, price refresh, fund analysis). Connector calls that need WebCrypto follow that precedent.
- The browser database can be saved to a user-chosen `.db` file or downloaded (`client-database.ts:283`), and "a server profile export can be opened locally and vice versa". Anything stored in plain text in browser SQLite leaves with that file.
- CSP: `connect-src 'self' https://cloudflareinsights.com` (`security_headers.py:59`). The browser cannot call a bank data provider directly without widening the CSP, and SimpleFIN documents no CORS support.

### 1.4 Server mechanics

- No scheduler exists. `main.py` lifespan runs one bootstrap task; `app.state.http` is an `httpx.AsyncClient` with `follow_redirects=True` (unsafe for user-supplied URLs; connectors must not reuse it).
- `httpx` 0.28.1 is already pinned; no new dependency is needed.
- Rate limiting (`src/middleware/rate_limit.py`): one shared AI window per IP plus named `BULK_LIMITS` buckets (analyze and recurring, 30 per 60 s). Active only with `RATE_LIMIT_ENABLED=true` and a secret key; per process.
- Profiles: per-profile SQLite; `export_profile` zips the profile and `duplicate_profile` copies it.

## 2. Provider research (verified 2026-10-04 to 10-06)

### 2.1 SimpleFIN Bridge (primary)

- **Protocol** ([simplefin.org/protocol.html](https://www.simplefin.org/protocol.html)): the user gets a base64 **Setup Token** from the bridge; the app decodes it to a claim URL and POSTs to it once; the response body is an **Access URL** of the form `https://user:pass@host/simplefin`. Data: `GET {access_url}/accounts` with `start-date`, `end-date` (Unix seconds), optional `pending=1`, repeatable `account`, `balances-only=1`, `version`. Accounts carry `id`, `name`, `conn_id`, `currency`, `balance`, `available-balance`, `balance-date`, `transactions`, `extra`; transactions carry `id`, `posted`, `amount`, `description`, `transacted_at`, `pending`, `extra`. v2 adds `connections` (`conn_id`, `name`, `org_id`, `org_url`, `sfin_url`) and `errlist` (codes such as `gen.auth`, `con.auth`, `act.failed`), replacing `errors`. HTTP 403 on claim means "token invalid or already claimed, possibly compromised"; 403 on `/accounts` means revoked or wrong credentials; 402 means payment required. No pagination: one response per date window.
- **Bridge rules** ([developer guide](https://beta-bridge.simplefin.org/info/developers)): "You are expected to make 24 requests or fewer per day", with some leeway during setup; exceeding it brings warnings, then the token is disabled. "The date range of requests to `/accounts` ... is limited to 90 days at a time." Overlap fetch windows by about 5 days. Scheduled fetchers should pick a random minute. Hosts: `bridge.simplefin.org` (which currently redirects to `beta-bridge.simplefin.org`) and `beta-bridge.simplefin.org`. A demo setup token is available on the developer page.
- **Price** ([bridge home](https://beta-bridge.simplefin.org/)): the **user** pays "$1.50 + tax per month, or $15.00 + tax per year", for up to 25 institutions and 25 apps. Finlity pays nothing and registers nothing.
- **Data freshness** ([Actual Budget docs](https://actualbudget.org/docs/advanced/bank-sync/simplefin)): "updates one time / day, roughly every 24 hours", at most 90 days of history per pull.
- **Terms** ([terms of use](https://beta-bridge.simplefin.org/info/terms)): users must "abide by the limits we publish"; nothing restricts which app holds a user's Access URL.
- **Not documented**: CORS, the sign of a credit card balance, and geographic coverage. The bridge's institution search is the coverage source of truth; it is US focused, so it most likely does not cover New Zealand banks. This is why Akahu matters.

### 2.2 Akahu personal app (second provider, New Zealand)

- **Fit** ([personal apps](https://developers.akahu.nz/docs/personal-apps)): a personal app is created **by the end user** at my.akahu.nz after accepting Akahu's Developer Terms, identity verification and MFA. It is free, limited to the user's own Akahu account, gives a **User Access Token** and an **App ID Token** (no App Secret), daily scheduled refresh, and a one hour minimum between manual refreshes. Actual Budget ships exactly this flow ([Actual docs](https://actualbudget.org/docs/advanced/bank-sync/akahu)). This is "user brings own token": Finlity registers nothing.
- **API** ([accessing account data](https://developers.akahu.nz/docs/accessing-account-data), [transactional data](https://developers.akahu.nz/docs/accessing-transactional-data)): base `https://api.akahu.io/v1`, headers `Authorization: Bearer <user token>` and `X-Akahu-Id: <app token>`; `GET /accounts`; `GET /transactions?start=&end=&cursor=` with cursor pagination; pending transactions on a separate endpoint; 401 after a token is regenerated.
- **Cautions** ([personal apps advanced](https://developers.akahu.nz/docs/personal-apps-advanced)): personal apps "have broad access to your data by default" and can be locked down; the user can whitelist IPv4 ranges (which would break hosted proxying from changing dyno IPs). The personal app tier also lists payment limits, so Finlity calls only an allowlist of GET paths (section 8.2). No "own use only" clause was found in the public docs; the Developer Terms themselves are behind sign-in and go on the operator list (section 16) as a confirmation, not a blocker.

### 2.3 Alternatives where the user brings credentials

- **Akahu personal app**: chosen (above).
- **Teller developer tier** (free to 100 live connections): requires a Teller developer account with mTLS application certificates held by the app operator. That is a developer-held credential, so it is an operator decision, not built.
- **Self-hosted SimpleFIN servers**: the protocol is open; a self-hoster could point Finlity at another SimpleFIN server. Supported in server mode only through an operator-set host allowlist extension (section 8.1).
- **OFX Direct Connect**: user-held bank credentials sent to bank OFX servers. Rejected: few banks still offer it, it means storing bank passwords, and it needs a broad outbound host list.

## 3. Key decisions

| # | Decision |
|---|---|
| C1 | **One Python connector core, stateless, used by both modes** (`src/connectors/`). It fetches from the provider, maps to `NormalizedStatement` and runs `finalize_statement`. The browser never sees raw provider JSON, so there is no TypeScript twin of the normalizer or the rule engine (project 3, K1). |
| C2 | **The server always proxies provider calls; the browser never calls a provider.** CSP `connect-src 'self'` and SimpleFIN's undocumented CORS rule out direct browser fetches, and one code path is safer than two. |
| C3 | **Token storage.** Server mode: Fernet ciphertext in `app_settings` row `connection_secret:<id>`, read only through new DB-only helpers. Hosted: AES-GCM ciphertext in the browser's `app_settings` row `connection_secret:<id>`, sealed with a **non-extractable WebCrypto key** kept in a separate IndexedDB database. The hosted server never stores a token; it receives one per request in the JSON body and drops it when the request ends. Tokens never appear in URLs, query strings, logs, error bodies or list responses. |
| C4 | **No new table.** Connection metadata is one sanitized JSON row in `app_settings` (`connections`); secrets are one row each. `smart_import_meta.connection_id` already links imports to a connection. No new index either: `create_all` does not add an index to an existing table, and a browser-only index would break schema parity; scanning `smart_import_meta` (hundreds of rows) is cheap. |
| C5 | **Sync enters the wizard at preview.** "Sync now" fetches, then opens the smart import wizard with the statements as if analyze had returned them. Preview marks duplicates via `dedupe_key`; review, apply, ledger and undo are unchanged. |
| C6 | **No stored sync cursor.** The next window starts from the applied imports themselves (`period_end` of the connection's imports, minus a 5 day overlap). Undoing a sync automatically rewinds it; a cursor would drift. |
| C7 | **Manual sync only; never auto-apply.** No server scheduler in this project: none exists, Global Constraints forbid startup writers, and an applied import creates expenses and debt snapshots that should be reviewed. Instead the app shows a "sync due" prompt when a connection has not synced for 24 hours (both modes, no fetch until the user clicks). A server cron with rule-only auto-apply is sketched in section 16. |
| C8 | **Real providers on a shared deployment are off unless the operator opts in** (`CONNECTORS_ENABLED=true`). Shared means Heroku (`DYNO`), `MULTI_USER_MODE` or `PROTECT_DEMO_DATA` (the `is_multi_user_mode` rule), because the operator's server makes bridge calls carrying visitors' tokens. The demo provider always works. A single-user server (self-hosted) is on by default. (Widened from Heroku only after the A1/A2 review.) |
| C9 | **Server-mode connection storage refuses shared deployments.** `/api/connections/*` FastAPI routes return 403 `connections_unavailable` when `on_heroku()` or `is_multi_user_mode()`, so no token can ever be written to a shared server database. |
| C10 | **One provider request per Sync request, at most 90 days.** Each sync request fits Heroku's 30 s; longer gaps are walked window by window by the client, each counted against the bridge's 24 per day guidance. |
| C11 | **Posted transactions only.** Pending ids change at settlement, which would defeat `external_id` dedupe. |
| C12 | **Zero new dependencies.** `httpx` (pinned), stdlib `base64`, `hashlib`, `hmac`, `urllib.parse`, `decimal`; WebCrypto in the browser. |

## 4. Architecture

```
            browser                                   server
 Settings > Connected accounts
   Connect  ----------------------->  claim / accounts (v2, stateless)  ---> provider
            <-- access secret (hosted) / stored encrypted (server mode)
 Sync now
   plan (data layer: since per account, quota)        
   sync ---------------------------->  v2 sync (hosted, token in body) ---> provider
            or  /api/connections/{id}/sync (server mode, token from DB)  ---> provider
            <-- NormalizedStatement[] (finalized with the user's rules)
   wizard: preview -> (AI categorize) -> review -> apply (connection_id) -> undo
```

Hosted mode never calls `/api/connections/{id}/sync` on the network: an async composite in `client.ts` reads the plan and the sealed secret from LocalAPI, unseals it with WebCrypto, posts to `/api/v2/connectors/{provider}/sync`, and records the outcome locally. The same frontend code calls the same `/api/connections/...` URLs in both modes.

## 5. Connector interface (`src/connectors/`)

### 5.1 Provider protocol (`base.py`)

```python
class ConnectorProvider(Protocol):
    id: str                      # "simplefin" | "akahu" | "demo"
    display_name: str
    max_window_days: int         # 90 for SimpleFIN and Akahu, 90 for demo
    daily_request_budget: int    # 20 for SimpleFIN (bridge says 24), 48 for Akahu, unlimited demo

    def claim(self, client: SafeClient, setup: str) -> Credentials: ...
    def list_accounts(self, client: SafeClient, creds: Credentials) -> AccountsResult: ...
    def fetch(self, client: SafeClient, creds: Credentials,
              accounts: list[AccountRequest], start: date, end: date) -> FetchResult: ...
```

- `Credentials` is an opaque frozen dataclass whose `__repr__` and `__str__` return `"<credentials>"` (so an accidental `%s` cannot leak it). SimpleFIN: `base_url`, `username`, `password`. Akahu: `user_token`, `app_token`. Demo: none.
- `AccountsResult`: `accounts: list[ProviderAccount]` (`provider_account_id`, `name`, `institution`, `currency`, `balance`, `balance_date`, `kind_guess`, `account_key`) and `errors: list[str]` (codes only).
- `FetchResult`: per account the raw-but-typed rows (`ProviderTxn`: `id`, `posted`, `amount: Decimal`, `description`, `payee`) and the balance, plus `errors` and `pages`. Pagination is the provider's concern: SimpleFIN has none (one response per window); Akahu follows `cursor.next` up to 20 pages per call; the demo has none.
- The registry (`registry.py`) maps id to provider and reports which are enabled (C8).

### 5.2 Mapping onto `NormalizedStatement` (`normalize.py`)

`to_statements(provider_id, fetch_result, accounts, window, context) -> list[NormalizedStatement]`, one statement per requested account that has transactions or a balance:

| Field | Value |
|---|---|
| `origin` | `connector` (via `context["origin"]`) |
| `format` | `connector` |
| `parser` | `connector:simplefin`, `connector:akahu`, `connector:demo` |
| `file_name` | `"<Provider> sync <end date>"`, e.g. `SimpleFIN sync 2026-10-06` (stored only in the user's database) |
| `file_hash` | SHA-256 hex of canonical JSON `{provider, account_key, start, end, sorted external ids, balance, balance_date}`; matches `_HASH`. Re-sending the same window is an exact duplicate file. |
| `account.key` | the mapped key from the request (see below) |
| `account.kind` | the request's kind (the user's mapping), else the provider guess |
| `account.last4` | null (provider ids are not account numbers); Akahu's formatted account number is not stored |
| `account.institution` | SimpleFIN connection `name` / Akahu `connection.name`, cut to 120 characters |
| `period` | `{start: account since, end: window end}` |
| `closing_balance` | the account balance at `balance-date`; for `credit_card` and `loan`, owed = `-balance` (holder's side, the OFX convention), then negated again if the mapping has `flip_balance`. Dropped when the date is in the future. |
| `transactions[]` | `posted_date` = UTC date of `posted` (SimpleFIN) or `date` (Akahu); `amount` from `Decimal`, rejected if not finite or beyond 1e10; `description` = `mask_description(description or payee)`; `merchant_key` from the description; `kind` = `infer_kind(description, amount, account_kind)`; `external_id` = `<provider>:<id>` cut to 200; `dedupe_base` = `dedupe_base(..., fitid=external_id)` |
| `warnings` | codes only (5.4) |

**Account keys.** New default: `acct:` + `sha256("finlity-conn-v1|" + provider + "|" + provider_account_id)`. Independent of the Finlity connection id, so reconnecting or reconnecting after a disconnect keeps the same keys and dedupe keeps working. The key still matches the `acct:` pattern in `settings_store._ACCOUNT_KEY`. When the user maps a connected account to an account they already import from files ("Same as: Everyday checking"), the mapping stores that existing key instead; then the first sync starts the day after the newest stored transaction for that key (C6), because file rows (FITID or row hash) can never dedupe against provider ids.

**Kind guess.** SimpleFIN has no account type. Guess `credit_card` when the name contains CARD, VISA, MASTERCARD or AMEX, `loan` for LOAN or MORTGAGE, `savings` for SAVING, else `checking` with a negative balance flagged for the user. Akahu `type` maps directly (`CHECKING`, `SAVINGS`, `CREDITCARD` to `credit_card`, `LOAN` to `loan`, others to `unknown`). The user confirms the kind once in the account mapping; the mapping wins from then on.

**Per-account start.** One provider request covers the connection; rows dated before an account's own `since` are dropped in the core (needed for the "same as" case).

**Categorization.** `finalize_statement` applies the user's rules (sent as `context`, exactly as analyze does) and the seed rules. AI categorization stays an explicit user action in the wizard (project 3, 6.2).

### 5.3 Errors (`errors.py`)

`ConnectorError(error_type)` with a fixed catalog, raised as `SmartImportError`-compatible bodies through the reused route class:

| error_type | Status | Meaning and UI action |
|---|---|---|
| `bad_setup_token` | 422 | Not base64, or the claim URL fails the allowlist |
| `claim_refused` | 422 | Bridge 403 on claim: "This setup token was already used or is not valid. If you did not use it, disable it at SimpleFIN Bridge." (protocol guidance) |
| `host_not_allowed` | 422 | Access URL host, scheme, port or userinfo fails 8.1 |
| `reconnect_needed` | 409 | Provider 401 or 403 on data: revoked or wrong credentials |
| `payment_required` | 409 | SimpleFIN 402: the user's bridge subscription lapsed |
| `provider_rate_limited` | 429 | Provider 429 or a rate-limit errlist entry |
| `quota_reached` | 429 | Finlity's own daily guard (8.4) would be exceeded |
| `window_too_long` | 422 | Requested window over `max_window_days` or in the future |
| `provider_timeout` | 504 | Connect or read timeout, or the 20 s wall clock |
| `response_too_large` | 502 | Body over the cap |
| `provider_bad_response` | 502 | Redirect, non-JSON, schema mismatch, too many accounts or rows |
| `provider_unavailable` | 502 | Network error or provider 5xx |
| `connector_disabled` | 503 | Provider not enabled on this deployment (C8) |
| `connections_unavailable` | 403 | Server-mode store on a shared deployment (C9) |
| `connection_not_found` | 404 | Unknown connection id |

### 5.4 New warning codes (`types.py WARNINGS`, client wording first)

`connector_account_error` (an errlist entry or an Akahu `INACTIVE` account: other accounts still synced), `connector_partial` (Akahu pagination stopped at the page cap; the window end is moved back to the last complete day so the next sync resumes), `connector_balance_only` (an account returned a balance and no transactions), `currency_unsupported` (currency is not a 3-letter ISO code; the account is skipped).

## 6. Endpoints

### 6.1 Stateless v2 (`src/api/v2/connectors.py`, route class `SmartImportRoute`; hosted reaches it via the existing `/api/v2/**` PASSTHROUGH)

| Method and path | Body | Response |
|---|---|---|
| `GET /api/v2/connectors/status` | | enabled providers, limits, allowed hosts (names only) |
| `POST /api/v2/connectors/simplefin/claim` | `{setup_token}` | `{access_url}` (hosted only uses it; the browser seals it immediately) |
| `POST /api/v2/connectors/{provider}/accounts` | `{credentials}` | `AccountsResult` (SimpleFIN uses `balances-only=1`: one bridge request) |
| `POST /api/v2/connectors/{provider}/sync` | `{credentials, start, end, accounts: [{provider_account_id, since, account_key, kind, flip_balance}], context: {rules, categories}}` | `{statements: NormalizedStatement[], account_errors: [{provider_account_id, code}], window: {start, end}}` |

`credentials` is `{access_url}` for SimpleFIN, `{user_token, app_token}` for Akahu, `{}` for the demo. Nothing here opens a database or writes a file (a test patches `get_database` and `Database` to raise, as project 3 does).

### 6.2 Data layer (both paths: FastAPI `src/api/connections.py` + `src/connectors/store.py` + `src/connectors/service.py`; LocalAPI `src/web/src/database/local-connections.ts`)

| Method and path | Server mode | Hosted |
|---|---|---|
| `GET /api/connections` | list, never secrets | `local()` |
| `POST /api/connections` | `{provider, label, setup_token \| access_url \| user_token+app_token}`: mint the id, claim if needed, encrypt and **commit** the connection with no accounts, then list accounts and merge them; return the connection | composite in `client.ts`: mint the id (`crypto.randomUUID()`), v2 claim, seal, `LocalAPI.createConnection(meta, sealed)`, then v2 accounts and `mergeConnectionAccounts` |
| `GET /api/connections/{id}` | detail: accounts with mapping, `next_since` per account, status, quota left | `local()` |
| `PUT /api/connections/{id}` | `{label?, accounts?}` (mapping: kind, role, label, liability_id, flip_balance, same_as_key) | `local()` |
| `POST /api/connections/{id}/credentials` | reconnect: replace the secret, keep id and mapping | composite |
| `POST /api/connections/{id}/accounts` | refresh the account list (new accounts default to role `cash_flow` and disabled until mapped) | composite |
| `POST /api/connections/{id}/sync` | `{window_index?}`: compute the plan, call the core with the stored token, record status and request time | composite: `LocalAPI.getConnectionSyncPlan(id)`, unseal, v2 sync, `LocalAPI.recordConnectionResult(id, result)` |
| `DELETE /api/connections/{id}?remove_data=false\|true` | disconnect (8.6) | `local()` |

Changes to existing data-layer endpoints (both paths): `ApplyStatement` gains `connection_id: Optional[str]` (required when `origin='connector'`, must name an existing connection, else 404 `connection_not_found`); Apply writes it to `smart_import_meta.connection_id`; `GET /api/smart-import/imports` returns `connection_id`.

## 7. Storage (no schema change)

### 7.1 `app_settings` row `connections` (both paths, sanitized on every read like `settings_store.sanitize`)

```json
{"version": 1,
 "items": {
   "<uuid>": {
     "provider": "simplefin | akahu | demo",
     "label": "My SimpleFIN",
     "created_at": "ISO", "status": "ok | accounts_pending | reconnect_needed | payment_required | rate_limited | error",
     "status_at": "ISO", "last_synced_at": "ISO or null",
     "requests": ["ISO", "..."],
     "accounts": {
       "<provider_account_id>": {"name": "Visa", "institution": "Bank", "currency": "USD",
         "kind": "credit_card", "role": "debt | cash_flow | ignore", "label": "Visa",
         "account_key": "acct:...", "liability_id": "uuid or null", "flip_balance": false}
     }}}}
```

Caps: 10 connections, 50 accounts per connection, labels 120 characters, `requests` keeps the last 24 hours only (at most 64 entries). Unknown keys are dropped. Provider account ids are opaque provider identifiers, not account numbers, and stay in the user's own database. The connection id is a UUID minted before any secret is sealed: by `create_connection` on the server, by the create composite in the browser (it is the AES-GCM additional data, 7.2).

### 7.2 Secrets

- **Server mode:** row `connection_secret:<id>`, `encrypted=1`, value `fernet:...` via new `SecretsManager.set_stored_secret / get_stored_secret / delete_stored_secret`, which read and write the database only (no env, `.env` or `config.yaml` lookup) and raise `SecretUnreadable` on `InvalidToken`, which the service maps to status `reconnect_needed`. The plaintext is a compact JSON of the credentials. A profile export or duplicate carries only ciphertext; on another host it fails to decrypt and the UI asks to reconnect.
- **Hosted:** row `connection_secret:<id>`, `encrypted=1`, value `wc1:<iv b64>:<ciphertext b64>` (AES-GCM 256, 12-byte random IV, additional data = the connection id so a ciphertext cannot be moved to another connection). The key is a non-extractable `CryptoKey` generated once and stored in IndexedDB database `FinlityConnectorKeys` (store `keys`, id `connector-v1`), separate from `PortfolioApp` so its fixed version 1 is untouched. A saved or downloaded `.db` file holds ciphertext only; opening it in another browser, or after clearing site data, shows "Reconnect on this device". Threat model, stated in the UI and docs: this protects the exported file and casual inspection, not a script running inside the page (which could call decrypt). The existing CSP and `textContent`-only DOM rules are the XSS defence.
- A `fernet:` value seen by the browser, or a `wc1:` value seen by the server, is treated as unreadable (reconnect).

### 7.3 Migration rule check

No `CREATE TABLE`, no index, no `ALTER`, no `SCHEMA_VERSION` change, on either path. The only "migration" test is the project 3 pattern: copy `demo.db`, open twice, every pre-existing table unchanged, and the two new `app_settings` rows appear only after a user action.

## 8. Security and privacy

### 8.1 SSRF and transport (`src/connectors/http.py SafeClient`)

- Its own `httpx.Client` per request (never `app.state.http`): `follow_redirects=False` (any 3xx is `provider_bad_response`), `trust_env=False` (no proxy env vars), timeouts connect 5 s, read 15 s, pool 5 s, plus a 20 s wall clock per call, TLS verification on.
- **Allowlist**, checked on the claim URL, the Access URL and every outgoing request: scheme `https`; host exactly `bridge.simplefin.org` or `beta-bridge.simplefin.org` (SimpleFIN), `api.akahu.io` (Akahu); port absent or 443; no IP literals; Access URL path must start with `/simplefin`; userinfo required for an Access URL and forbidden elsewhere. Server mode only (never when `on_heroku()` or multi-user): `CONNECTORS_SIMPLEFIN_EXTRA_HOSTS` adds comma-separated hostnames for self-hosted SimpleFIN servers, still https, port absent or 443, no IP literals, and every resolved address must be public (checked with `ipaddress` over `socket.getaddrinfo` before each request; any private, loopback, link-local or reserved address refuses the request). A DNS rebind between the check and the connect remains possible for these operator-chosen hosts only; that residual risk is accepted because the operator set the host and the feature is off on shared deployments.
- The Access URL is split with `urlsplit`; userinfo is removed from the URL and sent as `auth=(user, password)`, so request URLs, httpx log lines and exception messages never carry the secret. The `httpx` and `httpcore` loggers are not configured by Finlity, and a caplog test at DEBUG proves no secret appears even if they are.
- Akahu: only `GET /v1/accounts` and `GET /v1/transactions` (and `GET /v1/accounts/{id}/transactions` if needed) are callable; the client refuses any other method or path, so a personal app token can never move money through Finlity.
- Response bodies are read through a byte counter: 10 MB cap (`MAX_FILE_BYTES`), then `json.loads`; at most 50 accounts, 10,000 transactions per account (`MAX_TRANSACTIONS_PER_STATEMENT`), 20 Akahu pages per call, description inputs cut before masking.

### 8.2 Token handling

- Never logged, never in a URL or query string, never in an error body, never returned by a list or detail endpoint. The only response that contains a secret is v2 `claim`, to the same browser that sent the setup token, over HTTPS, with the existing `Cache-Control: no-store` for `/api/`.
- Server mode: the token is decrypted inside the sync handler and lives only for that call.
- Hosted: the token is unsealed in the browser for the duration of one v2 request.
- Setup token input and token fields are `type="password"`, `autocomplete="off"`, cleared after submit, and never prefilled.
- Logs: event name, connection id, provider id, counts, `error_type`, request duration. Never credentials, URLs, hostnames with userinfo, account names, institution names, descriptions or amounts. One caplog test per endpoint with a planted Access URL, user token, account name, merchant and amount.

### 8.3 Revocation and provider errors

| Provider answer | Finlity |
|---|---|
| SimpleFIN 403 on claim | `claim_refused` with the "may be compromised" advice |
| 401 / 403 on data | connection `status=reconnect_needed`; Sync disabled; "Reconnect" asks for a new setup token or Akahu tokens and keeps the connection id, mapping and imported data |
| SimpleFIN 402 | `status=payment_required`; link to the bridge |
| 429 or a rate-limit errlist entry | `status=rate_limited` until the next local day; Sync disabled with the time |
| `errlist` / `errors` per connection (`con.auth`, `act.failed`) or Akahu `INACTIVE` | those accounts are skipped with `connector_account_error`; the rest sync; the account shows "Your bank asked SimpleFIN to sign in again" |
| timeout, 5xx, bad JSON, redirect | fixed error, status unchanged, no request recorded as a success |

**Claim is one-time, so nothing may lose a claimed credential.** A SimpleFIN setup token can be claimed once (a second claim gets 403). The connect flow therefore stores the credential before any other provider call: claim, encrypt or seal, commit the connection with status `accounts_pending` and no accounts, and only then list accounts. If the account call fails, the connection stays with its credential, the UI shows "Accounts not loaded yet. Retry", and `POST /api/connections/{id}/accounts` finishes it. The user can also paste an Access URL directly (any input starting with `https://`), which recovers a credential claimed elsewhere.

Disconnecting in Finlity cannot revoke access at the provider (SimpleFIN has no app revoke call; Akahu tokens are the user's). The disconnect dialog says so and links to the place to revoke.

### 8.4 Rate limits

- **Finlity's own endpoints:** new `BULK_LIMITS` bucket `connectors` (10 requests per 60 s per IP) for `^/api/v2/connectors/[a-z]+/(claim|accounts|sync)$` and `^/api/connections(/[^/]+/(sync|accounts|credentials))?$`. Status stays unlimited. Separate from the AI window.
- **Bridge quota guard (both paths):** the data layer refuses a sync or account refresh with `quota_reached` when the connection's `requests` in the last 24 hours would exceed the provider's `daily_request_budget` (SimpleFIN 20, leaving headroom under the bridge's 24). Each provider call (claim, accounts, each sync window) appends a timestamp.
- **Server backstop for hosted:** the v2 routes also keep an in-memory, per-process counter keyed by `HMAC(process-random key, credential)` with the same budget per 24 hours, so a modified client cannot burn a user's token. The key is generated at process start and never stored; the counter holds no token.

### 8.5 Limits summary

| Limit | Value | Error |
|---|---|---|
| Window per sync request | 90 days, end not after today | `window_too_long` |
| Windows walked per "Sync now" | 4 (360 days); older gaps need another Sync now | client message |
| Statements per review | 12 (`MAX_APPLY_STATEMENTS`); more accounts or windows are reviewed in turns | client message |
| Response size | 10 MB | `response_too_large` |
| Accounts per connection | 50 | `provider_bad_response` |
| Transactions per account per window | 10,000 | `provider_bad_response` |
| Wall clock per provider call | 20 s | `provider_timeout` |
| Connections per database | 10 | `bad_request` |

### 8.6 Disconnect

- **Disconnect** (`DELETE /api/connections/{id}`): deletes the secret row and the metadata entry in one transaction. Imports keep their `connection_id` (a soft reference); history shows them as "from a removed connection", and each can still be undone.
- **Disconnect and remove imported data** (`?remove_data=true`): in one transaction, undoes every import whose `smart_import_meta.connection_id` is the id, newest first, using the existing `_undo` (server) and its browser twin, so the ledger rules hold: created expenses the user edited, or that a debt links to, are kept and listed; snapshots are removed and balances recomputed; transactions claimed by a file import are handed over, not deleted. Then the secret and metadata go. Any failure rolls everything back. Remembered merchants stay (user knowledge, as in project 3). The response is the summed undo result plus `imports_undone`.
- Both write paths call `check_demo_data_protection()` first (server).

### 8.7 Demo protection and hosted gating

Every server write calls `check_demo_data_protection()`. Server-mode routes refuse shared deployments (C9). Real providers on any shared deployment (Heroku or multi-user) need `CONNECTORS_ENABLED=true` (C8); the demo provider does not.

## 9. Sync model

### 9.1 Plan (data layer, both paths)

`next_since(account)`:

1. The newest `period_end` among this connection's imports for the account's key, minus 5 days (SimpleFIN guidance; dedupe absorbs the overlap).
2. Else, for a "same as" mapping onto an existing key, the day after the newest stored `posted_date` for that key.
3. Else the first-sync choice made when connecting: 30, 60 or 90 days back (default 90).

The plan returns, per enabled account (`role` not `ignore`), `since`, `account_key`, `kind`, `flip_balance`, plus the list of 90-day windows from the oldest `since` to today (at most 4), and the remaining quota.

### 9.2 Sync now (manual, both modes)

1. Settings or the Budget import card: "Sync now" on a connection.
2. For each window, oldest first: one sync request (server mode route or hosted composite). A failure stops the walk; completed windows still open in the wizard.
3. Statements with no transactions and no balance are dropped. If nothing remains: toast "No new transactions since <date>".
4. The wizard opens at the Accounts step with the statements (`origin='connector'`), runs preview (duplicates marked through `dedupe_key`, the already-synced overlap shows as duplicates and is not applied), recurring detection, optional AI, review, Apply with `connection_id`. Every connector import is undoable per import and per batch, exactly like a file.
5. After a successful Apply, the account mapping is updated with any debt link or kind the user changed in the wizard (`PUT /api/connections/{id}`), so the next sync does not ask again. `last_synced_at` is set when the sync request succeeds, whether or not the user applies.

### 9.3 Scheduled sync: decided against, for now

Decision: **no scheduled pulls and no auto-apply in this project.**

- There is no scheduler in the code base; adding one means a long-lived task that writes to the active profile's database outside any request, which the Global Constraints (no startup writers, a live database with real data) make risky.
- Apply does more than store transactions: it creates budget expenses from recurring bills and moves debt balances. The requirement is that every connected pull goes through review and undo.
- SimpleFIN data refreshes once a day; a daily manual sync loses little.

What ships instead: a **sync due prompt** in both modes. In the Budget > Expenses connections card, each connection with `status=ok` whose `last_synced_at` is older than 24 hours gets its own line ("Last synced 3 days ago. Sync now to check for new transactions."), with that connection's Sync now button and a Dismiss button. Dismiss hides the line for that connection for the rest of the browser session (sessionStorage, with an in-memory fallback when storage is blocked); focus moves to the row's Sync now, or to the card when Sync is unavailable. The prompt never fetches by itself. The server-cron variant (server mode only, daily at a random minute, fetch plus preview, auto-apply only when every new row matches a user rule and only for already-mapped accounts, never recurring candidates) is in the operator decisions (section 16) with its cost.

## 10. Account mapping

Each connected account has one role:

| Role | Effect |
|---|---|
| `cash_flow` (default for checking and savings) | transactions only; feeds spending totals and recurring detection |
| `debt` (default for credit card and loan) | transactions plus the closing balance; linked to a liability (`liability_id`), so Apply records a balance snapshot through the existing project 3 path (7.3 there: never overwrites a same-day entry, undo recomputes) |
| `ignore` | not requested and not synced |

The connect dialog's mapping step suggests a liability by lender or name (the existing `_lender_match` logic), or the liability previously linked to the same account key (`_previous_liability`). "Add as a new debt" opens the existing debt wizard prefilled. Kind, label, role, debt and "same as" are editable later in Settings. The wizard's Accounts step shows the mapping prefilled; changes made there are written back after Apply (9.2 step 5). Card payments in transactions never change a balance (liabilities decision 3).

## 11. Demo connector

- Provider `demo` (`src/connectors/demo.py`), no credentials, no network, enabled everywhere (hosted included, with or without `CONNECTORS_ENABLED`).
- Two accounts, "Demo Everyday" (checking) and "Demo Rewards Card" (credit card), ids `demo-chk` and `demo-card`.
- Transactions are generated deterministically per calendar day from a hash of the date and account: a fixed merchant list taken from the project 3 sample statement (so the seed rules categorize every row, a test asserts it, and no AI is needed), a fortnightly salary, monthly bills (Netflix, an electricity bill, phone) on fixed days, external ids `demo:<account>:<YYYY-MM-DD>:<n>`. Dates are relative to today, because connector imports are subject to the retention prune (the `sample` exemption does not apply). Running Sync now on two different days shows only the new days; the overlap shows as duplicates.
- The card balance is a deterministic function of the date.
- In hosted mode the connect dialog shows "Try a demo bank (synthetic data)"; it creates a normal connection entry with provider `demo`, so the whole flow (connect, map, sync, review, apply, undo, disconnect and remove data) is exercised with no token.
- The demo provider counts no quota and makes no network call; it still goes through the same v2 route, normalizer and `finalize_statement`.

## 12. UI

- **Settings > Connected accounts** (both modes; in hosted mode real providers appear only when `/api/v2/connectors/status` says they are enabled): list of connections with provider, label, status chip (Connected, Needs reconnect, Subscription issue, Rate limited until <time>), last synced, accounts count, quota left today; actions Sync now, Edit accounts, Reconnect, Disconnect.
- **Connect dialog** (`features/connections.ts`, `feature-*` chunk, `createDynamicModal`): 1. provider (SimpleFIN Bridge: "Your SimpleFIN Bridge subscription costs $1.50 a month or $15 a year, paid to SimpleFIN"; Akahu (New Zealand): "Create a free personal app at my.akahu.nz and paste its two tokens"; Demo bank). 2. credential entry with a "What Finlity does with this" disclosure (where it is stored in this mode, that each sync passes through Finlity's server and is not stored or logged there, how to revoke). 3. first-sync range (30, 60, 90 days). 4. account mapping (role, kind, label, debt, same as). 5. Done, with "Sync now".
- **Disconnect dialog**: "Disconnect" or "Disconnect and remove imported data" (with the counts from the imports list: "Removes 4 syncs, 312 transactions, 1 expense it added and 2 debt balances. Remembered merchants stay."), plus the provider revoke link.
- **Wizard** (branch code): `OpenSmartImportOptions.connection = {connection_id, provider_label, statements}`; statements become `WizardFile`s with `origin: 'connector'` (types widened), the Upload step is skipped, the Accounts step shows the connection's account cards, `buildApplyRequest` sends `connection_id`, rules remembered from connector rows carry `source: 'connector'`.
- **Budget > Expenses import card**: connections listed with Sync now; import history labels connector imports with the provider name ("SimpleFIN Bridge sync, Oct 6") and keeps per-import Undo. When the import's connection no longer exists, the entry is titled "Bank sync, Oct 6" with a "Connection removed" chip (if the connections list cannot load, the title is "Bank sync" with no chip). The card and the history share one `/api/connections` request per load. The sync due prompt is one line per due connection (9.3).
- Phone, themes, `textContent` only, same breakpoints and variables as project 3.

## 13. Both data paths

Every data-layer endpoint in 6.2 ships in FastAPI and in LocalAPI (`local-connections.ts`) with a `local()` route or a `client.ts` composite, a type in `api.d.ts`, a pytest and a vitest. Composites are tested by mocking `fetch` and the seal module. Parity: `tests/fixtures/connections_scenario.json` (pinned `today`, default categories, one credit card liability, fixed `NormalizedStatement`s with `origin='connector'` instead of a network fetch, and a secret stub) drives: create connection (metadata), get (next_since for first sync), put mapping, apply sync 1 with `connection_id`, get (next_since moved), list imports (shows `connection_id`), apply sync 2 overlapping (duplicates), undo sync 2, get (next_since rewound), disconnect without data (imports stay), a second connection then disconnect with `remove_data` (imports undone, an edited expense kept). Run through FastAPI (`TestClient`, temp database) and `tryLocalRoute`, compared against `connections_scenario.expected.json`.

## 14. Testing summary

- Core: SimpleFIN setup token decode (good, bad base64, claim URL off the allowlist), claim 200 / 403, accounts and sync from recorded fixtures (`tests/fixtures/connectors/simplefin/*.json`, recorded once from the bridge's public demo token and reviewed to be synthetic; tests never touch the network, `httpx.MockTransport` everywhere), errlist mapping, 402, 403, 429, redirects refused, oversize body, slow body (wall clock), non-JSON; Akahu accounts, cursor pagination, page cap, 401, GET-path allowlist; demo determinism and seed-rule coverage.
- SSRF: every allowlist rule, IP literals, userinfo on the claim URL, port 8443, `http`, `bridge.simplefin.org.evil.com`, `evil.com@bridge.simplefin.org`, extra hosts ignored on Heroku, private address refusal.
- Normalization: account keys (two opaque ids at one institution give two keys), balance sign and flip, per-account since filter, file_hash stability, warnings in the vocabulary.
- Privacy: caplog with planted secrets at DEBUG including `httpx`/`httpcore`; error bodies fixed; v2 handlers never open a database; list and detail responses contain no secret (asserted by scanning the JSON for the planted token).
- Storage: Fernet round trip, `InvalidToken` gives `reconnect_needed`, DB-only lookup ignores an env var of the same name; browser seal round trip with WebCrypto (jsdom plus Node's `webcrypto`), wrong connection id fails, `fernet:` value in the browser treated as unreadable.
- Data layer: next_since rules, quota guard, connection_id validation, disconnect both variants, parity.
- Migration safety: demo.db copy opened twice, no table or index change.
- Layout check on `settings` and `budget` in server and hosted emulation, 0 problems; screenshots at 390 and 1440 in both themes.

## 15. Aggregators not built (comparison)

All of these need Finlity (the operator) to register as a developer, hold an API secret or certificate, accept the provider's terms and usually pay per connected user. None is built.

| Provider | Coverage | Who holds the secret | Published price | Effort to add on top of this design | Notes and sources |
|---|---|---|---|---|---|
| SimpleFIN Bridge (built) | US focused (bridge institution search) | the user (Access URL) | user pays $1.50/month or $15/year | done | [bridge](https://beta-bridge.simplefin.org/), [developers](https://beta-bridge.simplefin.org/info/developers) |
| Akahu personal app (built) | New Zealand | the user (two tokens) | free | done | [personal apps](https://developers.akahu.nz/docs/personal-apps) |
| Akahu full app | New Zealand | operator (app id and secret, OAuth) | usage based, contact Akahu | M: OAuth redirect flow, server-held app secret, hosted callback | [personal apps](https://developers.akahu.nz/docs/personal-apps), [Open Banking Tracker](https://openbankingtracker.com/api-aggregators/akahu) |
| Plaid | US, CA, UK, EU | operator (client id and secret) | Limited Production free for 200 API calls per product; Transactions is a monthly subscription per connected account, rate not published; Pay as You Go has no commitment, Growth needs 12 months | L: Plaid Link (third-party script, CSP change), server-held secret, webhooks, item lifecycle | [Plaid pricing](https://plaid.com/pricing/) |
| Teller | US | operator (mTLS certificate plus app id) | free for up to 100 live connections; then Transactions $0.30 per enrollment per month, Balance $0.10 per call | M: Teller Connect script, mTLS client cert on the server | [teller.io](https://teller.io/) (pricing as published on the site, via search 2026-10-05) |
| MX | US, CA | operator | enterprise, contact sales | L | [MX docs](https://docs.mx.com/api) |
| Finicity (Mastercard Open Banking) | US, CA | operator | custom usage based, not published | L | [G2 pricing summary](https://www.g2.com/products/mastercard-open-banking-formerly-finicity/pricing) |
| GoCardless Bank Account Data (Nordigen) | EU, UK | operator | was free; **new signups disabled** | not possible for new integrators | [dev.to report](https://dev.to/johnfrandsen/gocardless-bank-account-data-alternatives-what-to-use-when-signups-are-disabled-326d) |
| Basiq | Australia (NZ limited) | operator | $0.50 per user per month data access, $0.25 enrichment, plus a platform fee, 12 month minimum | M to L | [Basiq pricing](https://basiq.io/pricing) |

Effort key: M is roughly one more PR on top of the connector interface (provider class, its consent flow, secret handling); L adds a third-party UI script, webhooks or certificate management. Prices were read 2026-10-04 to 10-06 and change often; confirm before deciding.

## 16. Decisions for the operator

1. **Hosted real providers** (`CONNECTORS_ENABLED=true` on Heroku). Costs the operator nothing, but the dyno makes bridge calls carrying visitors' tokens in memory, and Akahu IP whitelisting will not work with changing dyno IPs. Default off; the demo works regardless.
2. **Akahu Developer Terms.** Akahu is built as a user-brings-own-token provider because the public docs show the user creates the personal app. Whoever operates a deployment should confirm, after signing in at my.akahu.nz, the Developer Terms do not forbid using personal app tokens in third-party software. If they do, PR A drops Task A6 and Akahu moves to the "full app" row above.
3. **Scheduled sync in server mode** (not built, C7). If wanted later: a daily task at a random minute for the active profile only, server mode only, off by default per connection; it fetches and previews, stores only a "N new transactions" count (never the transactions), and auto-applies only when every new row matches a user rule, the account is already mapped, and no recurring candidate or new expense is involved. Effort: one PR (scheduler lifecycle, quota sharing, a status badge). Risk: writes outside a request on the live database.
4. **Any paid aggregator** from section 15 (each needs a developer account, a secret and ongoing fees or a contract).
5. **Self-hosted SimpleFIN servers** (`CONNECTORS_SIMPLEFIN_EXTRA_HOSTS`, server mode only): built as planned unless the operator prefers the strict two-host allowlist everywhere.

## 17. Deferred

Pending transactions, Akahu enrichment (merchant names and NZFCC categories as an extra rule source), multi-currency, connector webhooks, revoking at the provider from inside Finlity, `merchant_key` from structured payee fields, and rate limiting the older v2 advisor and commentary endpoints (still open from project 3).
