# Project 3: Smart Import (design)

Status: proposed, 2026-10-05. Third of four projects (dashboard, liabilities, **smart import**, connections). Builds on `plans/2026-10-04-liabilities-design.md`, which reserved the `source` / `source_ref` / `source_detail` provenance fields on liabilities and the `source_ref` column on `liability_balance_snapshots` "for statement import dedupe and undo".

## 0. Goal

The request: "We need both a wizard and some AI-way to allow people to upload statements or connect (eventually) to other apps and import so that it can automatically categorize expenses. Nobody likes doing it manually."

Project 2 delivered the debt wizard. This project delivers the import: the user uploads bank, card and loan statements (CSV, OFX/QFX, text PDF); Finlity extracts transactions and statement balances, categorizes spending (remembered rules first, then optional AI), finds recurring bills, and updates debt balances. The user reviews everything in one fast table before anything is written, and any import can be undone completely.

Out of scope: account connections (project 4; the pipeline below accepts a connector's output without changes), scanned or image-only PDFs (no OCR dependency), Excel statements, investment or brokerage statements (the existing folder importer covers positions), budgeting envelopes, and editing transactions outside the import wizard.

## 1. What exists today (verified at `b5f4e7e`, which is `origin/main` 88407e5 plus PR C)

### 1.1 Bank statements (works, narrow)

| Piece | Where | State |
|---|---|---|
| `bank_statement_imports` table | `src/database/models.py:558`, `ClientDatabase.SCHEMA_SQL` (`client-database.ts:697`), legacy `_migrate_schema` block in `operations.py:193` | One row per uploaded file: `file_name`, `content_hash` (UNIQUE, SHA-256 of the bytes), `entity_id`, `row_count`, `status`, `error_message`, timestamps. Same shape in both schemas. |
| `recurring_candidates` table | `models.py:572`, `client-database.ts:710` | `import_id` NOT NULL FK to `bank_statement_imports`, `name`, `amount`, `frequency`, `occurrences`, `status` (`pending`/`accepted`/`rejected`), `created_expense_id`. |
| v1 upload | `src/api/bank_statements.py` `POST /api/budget/bank-statements/upload` | Parses CSV or PDF, stores one import row per new file, runs recurring detection over the whole batch, attaches all candidates to the first new import. Duplicate files (same hash) are skipped but re-parsed so they still feed detection. |
| v1 accept / reject / list | same file | Accept creates a `budget_expenses` row (category from request, else "Other") or links an existing active expense with the same name and frequency (`deduped: true`). |
| v2 stateless parse | `src/api/v2/bank_statements.py` `POST /api/v2/bank-statements/parse` | Hosted mode. Parses and detects recurring candidates with no DB access; returns per-file hash and row count plus candidates. |
| Hosted composition | `client.ts handleLocalBankStatementUpload` (intercepts the v1 upload URL), `LocalAPI.recordStatementImport / acceptCandidate / rejectCandidate / getStatementImports` (`local-api.ts:3200-3400`), `local()` routes in `dispatcher.ts:744` | Browser posts files to v2 parse, then records imports and candidates in browser SQLite with hash dedupe. |
| UI | `index.html:1508` "Import Bank Statements" card on Budget > Expenses; `features/bank-statements.ts` | Upload button, drop zone, a review list of recurring candidates with a category select, Accept / Reject / Cancel all. |
| Tests | `tests/test_bank_statement_pdf.py` (reportlab-generated PDF), `tests/api/test_v2_bank_statements.py`, `src/web/test/database/bank-statements.test.ts` | Cover the current behavior. |

What it gets wrong or lacks:

- **Only recurring candidates survive.** Individual transactions are parsed, used for detection and thrown away. Nothing is categorized, so the "nobody likes doing it manually" problem is untouched.
- **CSV heuristics are fragile.** `_find_column` takes the first header matching `amount, debit, credit, ...`, so a file with separate Debit and Credit columns reads only one of them; there is no sign-convention detection (the recurring detector only counts positive amounts, so a bank that exports spending as negative produces no candidates); four US date formats only; no preamble skipping (many banks put account lines above the header); no transaction-type column; `_normalize_name` title-cases and keeps store numbers.
- **PDF is one hardcoded layout** (`_parse_usaa_pdf`). Anything else returns 422 "Currently only USAA checking account statements are supported". No page cap or extracted-text cap beyond pypdf's own limits.
- **No OFX/QFX.**
- **Dedupe is file-level only.** Overlapping exports (a 90-day CSV after a 30-day CSV) produce the same transactions again; there is no transaction-level key.
- **Undo does not exist.** And it could not be built on the current rows: accept returns `deduped: true` but never stores it, so a created expense cannot be told apart from a linked pre-existing one.
- **Privacy and safety gaps.** `logger.exception("Failed to parse bank statement CSV: %s", filename)` logs the file name (names and account digits are common in statement file names) plus a traceback that can carry row content; the 422 detail echoes `CSV parse error: {exc}` and the header list. The v1 write endpoints do not call `check_demo_data_protection()` (liabilities does). Starlette spools uploads above 1 MB to a temp file, which the handlers never close explicitly.
- **Unrelated pre-existing bug, noted not fixed:** the Add / Edit Expense modals (`pages/budget.ts:908`, `:1133`) hardcode category ids `'1'..'12'`, while both paths seed categories with UUIDs, which is why `/api/budget/expense-categories/repair-orphaned` exists. The import must take categories from `GET /api/budget/expense-categories` by id, never from that list.

### 1.2 Brokerage importers and plugins (not reusable here)

`src/importers/folder_scanner.py` and `file_importer.py` import **positions** from files on the server's disk, routed by `src/plugins/import_pipeline.py` to importer plugins (`schwab-csv`, `fidelity-csv`, `vanguard-csv`, `generic-csv`) by confidence score. They are path based, position shaped, and DISABLED in hosted mode (`dispatcher.ts`: `/api/imports/scan`, `/api/imports/process`, `/api/plugins/**`). Smart import does not route through plugins. Its parser registry (section 4) is the extension point instead, and section 12 notes how a plugin could add a parser later.

### 1.3 AI providers

- Server mode: `src/services/inference_provider.py` registers Claude, Cerebras, Gemini, OpenAI providers (plus plugin providers) with `complete(messages, model, max_tokens, system, temperature, ...)`. Keys come from env or the encrypted `app_settings` rows (`src/services/secrets.py`). `get_provider(provider_id, db)` falls back preferred, then Claude, then any available. `src/services/ai_config.py get_model_for_task('fast')` returns Haiku. There is no Ollama provider in the code base.
- The Settings "AI provider" select (`pages/settings.ts`) stores `preferredAIProvider` / model in `localStorage` only; no endpoint reads it today, so it is effectively cosmetic.
- Hosted mode: `/api/settings/api-key/**` is DISABLED ("API keys are managed by the server in hosted mode"). The v2 advisor and commentary endpoints (`src/api/v2/analysis.py`, `src/api/v2/commentary.py`) are stateless and use **only** the server's `ANTHROPIC_API_KEY` env var, with the user's data in the request body and nothing stored. That is Option 2 (stateless server proxy), and it is what this project follows.
- Rate limiting (`src/middleware/rate_limit.py AI_ENDPOINT_PATTERNS`) covers `^/api/commentary/`, `^/api/inference/`, `^/api/analysis/advisor/` only. **Nothing under `/api/v2/` is rate limited**, so the hosted advisor and commentary endpoints are unlimited today. This project adds its own AI paths to the list and flags the existing v2 gap (section 12) without widening scope to fix it.

### 1.4 Budget and liabilities

- `budget_expense_categories` (12 seeded defaults: Housing, Utilities, Transportation, Insurance, Healthcare, Debt Payments, Food & Dining, Entertainment, Savings & Investments, Personal, Education, Other) and `budget_expenses` (`name`, `amount`, `frequency`, `category_id`, `entity_id`, `is_active`, mortgage split). Category ids are UUIDs on both paths.
- `liabilities.source` / `source_ref` / `source_detail` and `liability_balance_snapshots(source, source_ref)` with the unique `(liability_id, snapshot_date)` index `ux_liability_snapshot_day`. `src/liabilities/service.py record_balance(db, id, balance, as_of, source)` upserts one row per day and moves `current_balance` / `balance_as_of` only when the day is the newest; `local-liabilities.ts` mirrors it. The liabilities design reserved `statement_import` as a future `source`; this project uses **`source='import'`** on snapshots as specified, and never changes a liability's own `source` (section 7.3).

### 1.5 The two data paths

- **Server mode:** FastAPI + SQLAlchemy over per-profile SQLite. Writes go through `get_db()` / `get_database()`.
- **Hosted mode (app.finlity.net, Heroku):** all user data lives in browser SQLite (`client-database.ts`). `apiCall` goes through `dispatcher.ts`: LOCAL routes run in `LocalAPI`; PAYLOAD routes POST locally built bodies to stateless `/api/v2/*`; an explicit PASSTHROUGH allowlist (`/api/v2/**`, `/api/tasks/**`, session, a few anonymous reads); anything else fails loudly. The server keeps no hosted user data.

## 2. Key decisions

| # | Decision |
|---|---|
| K1 | **One Python parsing and categorization core, stateless, used by both modes.** Parsing, normalization, rule and seed matching, recurring detection and AI calls live in `src/smart_import/` and are exposed as stateless `/api/v2/smart-import/*` endpoints. Both modes call them. The data layer (server `service.py` or `LocalAPI`) only does storage: duplicate lookup, apply, undo, history, rules, settings, spending totals. No parser or rule engine is written twice. |
| K2 | **Rules travel as payload.** The user's merchant memory lives in their database (browser SQLite in hosted mode), so the client reads it from the data layer and sends it with each analyze request, exactly as `buildPortfolioPayload()` sends a portfolio. |
| K3 | **AI is Option 2, consistent with the advisor and commentary.** Hosted: `/api/v2/smart-import/categorize` uses the server's env `ANTHROPIC_API_KEY` only, holds the request in memory for the call, stores and logs nothing. Server mode: `/api/smart-import/categorize` uses the provider registry with the profile's keys and honors the Settings provider choice. Option 1 (browser calls a provider with the user's own key) is rejected: it needs a new key-entry flow and CORS-enabled provider endpoints, and diverges from every existing AI feature. |
| K4 | **Hosted AI is off by default** behind env flags (`SMART_IMPORT_AI_ENABLED`, `SMART_IMPORT_PDF_AI_ENABLED`), because it spends the operator's key on anonymous visitors. Turning it on is an operator decision (section 14). With it off, hosted import is rules plus manual and still complete. |
| K5 | **Store individual transactions** in a new `import_transactions` table, with retention (default 24 months) and delete controls. Without them there is no category spending total, no recurring detection across months, no transaction-level dedupe and no correction learning. |
| K6 | **Four new tables, two reused, no ALTER.** `smart_import_meta`, `import_transactions`, `merchant_rules`, `smart_import_ledger`, plus one `bank_statement_imports` row per imported file (the existing file-level record and the FK target `recurring_candidates` needs). |
| K7 | **Nothing is written until Apply.** Upload, parse, categorize, recurring detection and review all happen in memory in the browser. Apply writes everything for a batch in one transaction and records every created or changed row in a ledger, so Undo is mechanical. |
| K8 | **Zero new Python and zero new npm dependencies.** CSV: stdlib `csv`. PDF: `pypdf` (already pinned with hashes, floor 6.16.1). OFX/QFX: a small tokenizer that never instantiates an XML parser, which removes the XXE and entity-expansion surface entirely, so `defusedxml` is not needed. If the tokenizer fails the OFX fixtures in PR A, the fallback is `defusedxml` added through `requirements.in` and `pip-compile --generate-hashes`; the plan treats that as a stop-and-report, not a silent addition. |
| K9 | **No uploaded file is ever kept**, in either mode. The parsed, masked transactions are all the pipeline needs afterward. This satisfies "not kept unless the user opts in" by never offering retention; a retention opt-in is deferred (section 12). |
| K10 | **Synchronous, small requests instead of background tasks.** Analyze is one file per request, categorize is at most 60 merchants per request, recurring detection is one cheap call per batch. Each stays well under Heroku's 30 s limit, and no statement content sits in the server's in-memory `background_tasks` results dict waiting to be polled. |
| K11 | **New route prefix `/api/smart-import`**, distinct from `/api/imports/*` (brokerage folder import, DISABLED in hosted) and `/api/budget/bank-statements/*` (legacy, kept working). |
| K12 | **A synthetic sample statement pair ships in the frontend** ("Try a sample statement"), and every merchant in it is covered by the built-in seed rules, so hosted visitors get a fully categorized run with zero AI spend and no demo-only code path. `data/demo/demo.db` is not changed by this project. |

## 3. Pipeline

```
 files --> analyze (v2, per file) --> preview (data layer) --> categorize (AI, optional, per chunk)
           parse + normalize          duplicate keys           minimized merchants only
           seed + user rules          prior imports
           dedupe base keys           liability suggestions
                                      recurring history
                    +-------------> recurring (v2, per batch)
                                             |
                          review wizard (browser memory only)
                                             |
                                     apply (data layer, one transaction, ledgered)
                                             |
                                     undo (data layer, by import id)
```

Connector path (project 4): a connector produces the same `NormalizedStatement` JSON that analyze returns (section 4.6) and enters at **preview**. Nothing after analyze knows whether the data came from a file.

### 3.1 Request sequence in the browser

1. `GET /api/smart-import/context` (data layer): rules (`merchant_key`, `category_id`, `kind`), categories (`id`, `name`), known accounts (label, last4, kind, account key, linked liability), CSV layouts remembered by header signature, settings.
2. For each file: `POST /api/v2/smart-import/analyze` (multipart: `file`, `context` JSON with rules, categories, optional `mapping`, optional `account_kind` hint, optional `flip_sign`, optional `date_order`). Response: one or more `NormalizedStatement`s, or `needs_mapping`, or `needs_ai_layout`.
3. `POST /api/smart-import/preview` (data layer) with every statement's `dedupe_key`s, `file_hash`es, account keys and merchant keys. Response: which keys already exist, which file hashes were imported before (and when), suggested liability per statement, and recurring history rows (`merchant_key`, `posted_date`, `amount`) for the batch's merchant keys over the last 400 days.
4. `POST /api/v2/smart-import/recurring` with the batch's outflows plus that history plus active budget expenses (`name`, `amount`, `frequency`, `category_id`). Response: recurring candidates, each flagged `already_budgeted` when it matches an active expense.
5. Optional: `POST /api/smart-import/categorize` (server mode) or the same path rewritten by the dispatcher to `/api/v2/smart-import/categorize` (hosted) for uncategorized merchants, in chunks of at most 60.
6. Review in the wizard.
7. `POST /api/smart-import/apply` once for the batch.

## 4. Formats and parsing (`src/smart_import/`)

### 4.1 Limits (`limits.py`), enforced before and during parsing

| Limit | Value | Error |
|---|---|---|
| Files per batch (client) | 12 | toast |
| Bytes per file | 10 MB (checked by reading at most limit+1 bytes) | 413 `file_too_large` |
| Extensions and sniffed type | `.csv`, `.txt` (CSV), `.ofx`, `.qfx`, `.pdf`; content sniffed (`%PDF-`, `OFXHEADER` or `<OFX>`), mismatches rejected | 415 `unsupported_type` |
| CSV rows | 20,000 | 422 `too_many_rows` |
| CSV field size | 10,000 characters (checked per field; `csv.field_size_limit` is process global, so it is not changed) | 422 `field_too_large` |
| OFX elements | 200,000 tags, tag name 32 chars, value 2,000 chars | 422 `ofx_too_large` |
| PDF pages | 60 | 422 `too_many_pages` |
| PDF extracted text | 2,000,000 chars total, checked page by page | 422 `pdf_text_too_large` |
| PDF wall clock | 20 s, checked between pages | 422 `parse_timeout` |
| Transactions per statement | 10,000 | 422 `too_many_rows` |

Encrypted PDFs are rejected unless they open with an empty password. PDFs are never rendered; JavaScript, forms, attachments and XFA are never read (text extraction only); pypdf's built-in stream and decompression limits stay at their defaults. CSV is decoded as UTF-8-SIG, then cp1252 as a fallback; nothing is ever evaluated (cells are strings, no spreadsheet formats accepted, so there are no macros or formulas to run). Uploads are read into memory and `await upload.close()` runs in a `finally`, so the spooled temp file (Starlette spools above 1 MB) is removed at once.

### 4.2 CSV (`parsers/csv_parser.py`)

- **Dialect:** `csv.Sniffer` on the first 8 KB restricted to `,;\t|`, default comma.
- **Header row:** scan the first 30 rows for the first row with at least two recognized header names. Preamble rows above it are ignored, which handles exports with account lines on top.
- **Columns recognized:** date (`date`, `transaction date`, `posted date`, `post date`, `posting date`, `trans date`), description (`description`, `merchant`, `payee`, `name`, `memo`, `details`, `transaction description`), amount (`amount`, `transaction amount`), debit (`debit`, `withdrawal`, `withdrawals`, `money out`, `charges`), credit (`credit`, `deposit`, `deposits`, `money in`, `payments`), type (`type`, `transaction type`, `dr/cr`), balance (`balance`, `running balance`), bank category (`category`, a weak hint only).
- **Amount shape:** one signed `amount` column; or a `debit` / `credit` pair (debit becomes negative); or `amount` plus a `type` column (`debit`, `dr`, `withdrawal` make it negative). Parentheses, currency symbols, thousands separators and trailing minus are handled; a decimal comma is detected when every amount matches `\d+,\d{2}$`.
- **Dates:** try `%Y-%m-%d`, `%m/%d/%Y`, `%m/%d/%y`, `%d/%m/%Y`, `%d.%m.%Y`, `%Y/%m/%d`, `%b %d, %Y`, `%d %b %Y` and keep the first format that parses **every** non-empty date. Ambiguous M/D versus D/M picks M/D and reports `date_order_assumed` so the wizard can offer a switch (sent back as `context.date_order`).
- **Sign convention:** internal amounts are signed, negative means money left the account. If the file uses positive for spending (common for card exports) the parser flips it when either most rows matched by a seed or user rule as `expense` are positive, or the account kind is `credit_card` and most rows are positive. It reports `sign_flipped` and the wizard offers "Amounts look reversed? Flip" (sent back as `context.flip_sign`).
- **Mapping fallback:** if no date, description and amount shape can be found, the response is `needs_mapping` with the header names and the first three rows (returned to the same client only), and the wizard shows a column picker. The chosen mapping is remembered in the user's database by header signature (SHA-256 of the lowercased joined headers) and sent back as `context.mapping` next time.
- **Balance:** if a balance column exists, the closing balance is the balance on the latest-dated row (ties: last in file order).

### 4.3 OFX / QFX (`parsers/ofx_parser.py`)

- Header: OFX 1.x SGML (`OFXHEADER:100`, `CHARSET:1252`) or OFX 2.x XML prolog. Body decoded per `CHARSET` (cp1252 or UTF-8).
- **Tokenizer, not an XML parser:** a regex scanner over `<TAG>value` and `</TAG>` tokens that tolerates unclosed SGML leaf tags. Any `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<![CDATA[` or processing instruction other than the `<?xml ...?>` / `<?OFX ...?>` prolog is rejected with 422 `unsupported_ofx`. Only `&amp; &lt; &gt; &quot; &apos;` and numeric references are decoded; anything else stays literal. Nothing is ever resolved from the network or the file system.
- Extracted: `BANKACCTFROM` (`BANKID`, `ACCTID`, `ACCTTYPE`) or `CCACCTFROM` (`ACCTID`), `FI/ORG`, `FI/FID`, each `STMTTRN` (`TRNTYPE`, `DTPOSTED`, `TRNAMT`, `FITID`, `NAME`, `MEMO`, `PAYEE/NAME`), `LEDGERBAL` (`BALAMT`, `DTASOF`), `BANKTRANLIST` (`DTSTART`, `DTEND`). Multiple statements in one file become multiple `NormalizedStatement`s.
- OFX amounts are already signed from the account holder's view (card purchases negative), so no sign inference. A card `LEDGERBAL` is negative when money is owed; the closing balance stored is its absolute value.
- `FITID` becomes the dedupe base (section 5).

### 4.4 PDF (`parsers/pdf_parser.py`, `parsers/pdf_layouts/`)

1. Extract text page by page with pypdf under the limits above. No text at all means a scanned PDF: 422 `no_text_layer` with a message suggesting the bank's CSV or OFX download.
2. Try registered **layout parsers** in order; each has `matches(text) -> bool` and `parse(text) -> NormalizedStatement`. Shipped: `usaa_checking` (the existing `_parse_usaa_pdf` logic moved and extended to keep credits) and `generic_lines`.
3. `generic_lines` grammar: a line that starts with a date (`MM/DD`, `MM/DD/YY`, `MM/DD/YYYY`, `Mon DD`) and ends with one or two money tokens (amount, optional running balance), with continuation lines appended to the description until the next date line. The year comes from a `Statement Period`, `Closing Date` or `Opening/Closing Date` header, with December-to-January rollover. Closing balance from `New Balance`, `Statement Balance`, `Ending Balance` or `Closing Balance` lines; card statements also read `Minimum Payment Due` and `Payment Due Date` into `extras` (shown to the user, not stored).
4. If neither parser yields at least one transaction, the response is `needs_ai_layout` with the masked candidate lines (section 6.3). The wizard offers the AI layout fallback only where it is enabled.

### 4.5 Normalization (`normalize.py`)

- **Description** stored and shown: whitespace collapsed, runs of 5 or more digits replaced by `#` (card, reference and phone numbers), `***`-masked tokens removed, e-mail addresses and URLs with a scheme removed, trimmed to 120 characters. The raw string never leaves the parser.
- **Merchant key** (what rules match on): uppercase the description; strip leading processor and channel prefixes (`SQ *`, `TST*`, `PAYPAL *`, `POS `, `DEBIT CARD PURCHASE`, `CHECKCARD`, `ACH DEBIT`, `PURCHASE AUTHORIZED ON MM/DD`, `RECURRING PAYMENT`, and similar); drop every token containing a digit, `#`, `*` or `/`; keep the first three remaining tokens. City and state suffixes are not stripped (too error prone; the three-token cap removes most of them). Golden examples: `SQ *BLUE BOTTLE COFFEE 12345 OAKLAND CA` gives `BLUE BOTTLE COFFEE`; `NETFLIX.COM 866-579-7172 CA` gives `NETFLIX.COM CA`; `AMAZON MKTPL*2K4X91 AMZN.COM/BILL WA` gives `AMAZON WA`. When the key would be empty, the key is the masked description uppercased.
- **Kind** (`expense`, `income`, `transfer`, `payment`, `refund`, `fee`, `interest`): from OFX `TRNTYPE` when present, else keywords (`PAYROLL`, `DIRECT DEP`, `SALARY` income; `TRANSFER`, `XFER`, `ZELLE`, `VENMO`, `CASH APP` transfer; `PAYMENT THANK YOU`, `AUTOPAY`, `ONLINE PAYMENT` on a card or loan statement payment; `INTEREST CHARGE`, `FINANCE CHARGE` interest; `FEE` fee), then sign (negative is expense; positive on a card is refund unless it is a payment; positive on checking or savings is income). The user can change it per row.
- **Seed rules** (`seed_rules.py`): a static table of about 200 keyword-to-category-name entries for common merchants (streaming, groceries, fuel, utilities, rideshare, airlines, pharmacies, telecom, insurers). A seed matches when the merchant key starts with its keyword. Category names map to the user's category ids by exact name; a renamed or deleted category means no seed match.

### 4.6 `NormalizedStatement` (the contract a connector also produces)

```json
{
  "file_hash": "sha256 of the bytes, or of the canonical JSON for a connector",
  "file_name": "as uploaded (stored only in the user's own database)",
  "origin": "file | sample | connector",
  "format": "csv | ofx | pdf | connector",
  "parser": "csv | ofx | pdf:usaa_checking | pdf:generic_lines | pdf:ai",
  "account": {"kind": "checking | savings | credit_card | loan | unknown",
              "key": "acct:<sha256> or null", "last4": "1234 or null", "institution": "string or null"},
  "period": {"start": "YYYY-MM-DD or null", "end": "YYYY-MM-DD or null"},
  "closing_balance": {"amount": 1234.56, "as_of": "YYYY-MM-DD"},
  "extras": {"minimum_payment": 35.0, "payment_due": "YYYY-MM-DD"},
  "warnings": ["date_order_assumed", "sign_flipped"],
  "transactions": [
    {"row": 0, "posted_date": "YYYY-MM-DD", "amount": -12.5, "description": "masked",
     "merchant_key": "BLUE BOTTLE COFFEE", "kind": "expense", "category_id": "uuid or null",
     "category_source": "rule | seed | none", "external_id": "FITID or null", "dedupe_base": "sha256"}
  ]
}
```

`closing_balance.amount` is the amount owed for card and loan accounts, positive when money is owed and negative when the account is in credit (the sign the liabilities table uses) and the plain balance for checking and savings. `closing_balance` and `extras` may be null.

Each parser converts from its source's convention (revised after the parser review, documented on `ClosingBalance` in `types.py`): OFX balances are from the holder's side, so owed is `-BALAMT` for `CCSTMTRS` and `CREDITLINE`; a PDF "New Balance" is owed as printed, and a minus, parentheses or `CR` mark a credit balance; a CSV balance column is read against the running amounts (moving with spending is the holder's side, against it the issuer's), and with too few rows to tell, a file whose spending is negative is taken as the holder's side and a sign-flipped file as the issuer's.

**Warnings.** `warnings` holds codes only, from one vocabulary (`WARNINGS` in `src/smart_import/types.py`): `rows_skipped`, `available_balance_used`, `duplicate_fitid`, `truncated_file`, `year_assumed`, `sign_assumed`, `date_order_assumed`, `sign_flipped`. The client owns the wording; a new code is added there first, and a test fails if a parser emits a code outside it. Every parser ends with `normalize.finalize_statement`, which applies rules, stores the file name's basename (at most 255 characters) and sets `origin` from the import context (default `file`).

## 5. Dedupe and idempotency

- **Account key.** `acct:<sha256("finlity-acct-v1|" + institution id + "|" + digits of the account id)>` when the file names an account (OFX always; PDF and CSV when an account number line is found). Otherwise the wizard asks "Which account is this?" with the user's known accounts or a new label, and the key is `label:<lowercased trimmed label>`. The account number itself is never stored; `last4` is stored for display.
- **Transaction key.** `dedupe_base` = `sha256("fitid|" + FITID)` when present, else `sha256(posted_date | amount in cents | merchant key | masked description | occurrence)` where `occurrence` numbers identical tuples within the file in order (two $4.50 coffees on the same day become occurrence 0 and 1). The stored `dedupe_key` is `<account key>|<dedupe_base>` (plain concatenation, so the browser needs no hashing), unique in `import_transactions`.
- **Re-importing the same file** finds the `file_hash` in an earlier `bank_statement_imports` row; the wizard says "Already imported on <date>" and every row shows as a duplicate, so the file is skipped at Apply. If the user undid the earlier import, the file imports normally.
- **Overlapping exports** dedupe row by row. The occurrence rule assumes an export contains whole days, which holds for the bank export formats we know; a partial-day overlap can at worst add one same-day duplicate, which the user can exclude.
- **Card and checking double counting:** the checking-side payment to a card is kind `payment` and excluded from spending, so card purchases count once.

## 6. Categorization

### 6.1 Order

1. **User rules** (`merchant_rules`, exact merchant key) during analyze. `category_source='rule'`.
2. **Seed rules** during analyze. `category_source='seed'`.
3. **AI** for the remaining unique merchant keys, only when the user asks and AI is available. `category_source='ai'` with `ai_confidence`.
4. **Manual** in the review table. `category_source='user'`.

Rows whose kind is not `expense`, `fee`, `interest` or `refund` get no category and are excluded from spending.

### 6.2 What is sent to the AI (and shown to the user)

The request body is built by one frontend function (`buildCategorizeRequest`) whose output is also what the disclosure panel renders, so the panel cannot drift from the payload:

```json
{"categories": ["Housing", "Utilities", "..."],
 "items": [{"id": "m1", "merchant": "BLUE BOTTLE COFFEE", "typical_amount": 5, "direction": "out", "count": 7}]}
```

- One item per **unique merchant key**, never per transaction. `typical_amount` is the median absolute amount rounded to whole dollars. No dates, balances, descriptions, memos, account data, file names or entity names.
- Rows of kind `transfer`, `income` and `payment` are never sent (they are the ones that carry personal names, like "ZELLE TO <name>").
- Merchant keys are cut to 48 characters; keys with fewer than 3 letters are not sent.
- The disclosure ("What gets sent") lists every merchant string and rounded amount, the provider and model, and states that Finlity's server does not store or log it.

Prompt: fixed system prompt in `src/smart_import/ai_categorize.py`, temperature 0, asking for a JSON array `[{"id","category","kind","confidence"}]` with `category` one of the given names or `null`. The response is parsed strictly: unknown ids are dropped, unknown category names become `null`, confidence is clamped to [0, 1], and an unparseable response returns 502 `ai_bad_response` with no detail. At most 60 items per request, `max_tokens` 4,000. Model: Claude Haiku via `get_model_for_task('fast')`; other providers use their default model.

Confidence: at or above 0.8 the suggestion is pre-filled and shown as "AI"; below 0.8 it is pre-filled but the row stays in "Needs review"; `null` stays uncategorized.

### 6.3 AI PDF layout fallback (`/api/v2/smart-import/extract`)

The only path that sends statement text. Per file, opt-in, and only when enabled (server mode: the user's setting; hosted: `SMART_IMPORT_PDF_AI_ENABLED`). Analyze returns the candidate lines (lines with a date token and a money token, plus the next line) already masked (digit runs of 5 or more and `***` tokens replaced) for a PDF it cannot read; the wizard shows the exact lines and count; only "Send these N lines" posts them to extract. At most 400 lines per request. The response is validated into transactions and then follows the normal pipeline with `parser='pdf:ai'`; the client keeps the analyze response's `file_hash` and account fields.

### 6.4 With no AI

Everything except 6.1 step 3 and 6.3 works. The wizard shows "AI suggestions are off" with a link to Settings (server mode) or nothing (hosted), and the user categorizes with bulk tools. Each correction is remembered, so the second month needs little work.

### 6.5 Learning

In review, changing a row's category or kind shows "Remember for all <merchant key>" (checked by default) and applies the change to every row in the batch with that key at once. On Apply each remembered choice upserts `merchant_rules` (`merchant_key` unique, `hits` incremented). Rules are user knowledge, not import data: Undo keeps them, and Settings lists them with delete. A rule pointing at a deleted category is ignored on read and listed as "category deleted".

## 7. Outputs

### 7.1 Transactions

Stored in `import_transactions` (section 8) unless excluded in review (excluded rows are not stored; a duplicate is never stored twice).

### 7.2 Recurring bills to budget expense suggestions

`recurring.py detect(rows, history, expenses)` groups outflows by merchant key and returns a candidate when either at least 3 occurrences fall within 10% of their median amount, or exactly 2 occurrences are 25 to 35 days apart within 10% (a monthly bill seen across two statements, history included). Frequency from the mean gap (weekly up to 9 days, biweekly up to 18, monthly up to 45, quarterly up to 100, annual above). A candidate is flagged `already_budgeted` (unticked by default) when an active budget expense has the same name case-insensitively, or the same category with an amount within 10%.

In the wizard's "Recurring bills" step the user ticks candidates and can edit name, amount, frequency and category. On Apply each candidate becomes a `recurring_candidates` row on the import of the file holding its latest occurrence (if that file was skipped as already imported, on the first import this batch creates; if the batch creates no import, candidates are dropped, since nothing could undo them), with `status` `accepted` (plus a created `budget_expenses` row, or a link to the matched existing one) or `rejected`. The new flow never leaves a candidate `pending`. Created expenses are ledgered `created`; links are ledgered `linked` and never deleted by Undo.

### 7.3 Statement balances to debt snapshots

For a statement of kind `credit_card` or `loan` with a closing balance, the Accounts step suggests a liability: first the one linked to the same account key in an earlier import (`smart_import_meta.liability_id`), then a case-insensitive match of the institution against `liabilities.lender` or `name`; the user can always pick another, skip, or "Add as a new debt" (opens the existing debt wizard prefilled with type, lender and balance; that debt is the user's own with `source='wizard'`, created before Apply, and is not removed by Undo). Suggestions are never applied automatically.

On Apply, for a linked liability: insert a `liability_balance_snapshots` row with `snapshot_date` = the closing date (refused if in the future), `balance` = closing balance, `source='import'`, `source_ref` = the import id; then move the liability's `current_balance` / `balance_as_of` only if that date is the newest snapshot, as `record_balance` does. If a snapshot already exists for that liability and day, Apply **skips** the import's balance and reports "A balance for <date> was already recorded", so an import never overwrites an entry. The ledger records the snapshot (`snapshot`) and the liability's previous `current_balance` and `balance_as_of` (`balance_moved`).

Card or loan payments seen in transactions never change a balance (liabilities design decision 3: reported balances only).

### 7.4 Category totals on the Budget page

`GET /api/budget/spending-summary?months=3&entity_id=` returns, per category: the average monthly actual spending from `import_transactions` (kinds `expense`, `fee`, `interest` as outflows, `refund` subtracted) over the most recent N complete calendar months that have statement coverage (not necessarily the last N calendar months, so older statements and the sample still show), the planned monthly amount from active `budget_expenses` (frequency converted to monthly), and the difference; plus an "Uncategorized" line and `months_covered`. A month has coverage when a `smart_import_meta` period overlaps it or, when periods are unknown, when it has at least one stored transaction. The Budget > Expenses sub-tab gets a "Planned vs actual" card. The paycheck, cash flow and projections math are unchanged (they keep using planned expenses). "Add to plan" on a category with actual spending but no planned expense opens the Add Expense modal prefilled with the category and the monthly average.

## 8. Schema (additive, both paths)

New tables only, created by `create_all` (server) and `CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS` (browser). No change to existing tables, `_migrate_schema`, `SCHEMA_VERSION` or `ClientDatabase.SCHEMA_VERSION`. References are soft (not foreign keys), following liabilities decision D2. Date columns are `Date` server side and `TEXT 'YYYY-MM-DD'` in the browser, local calendar days.

**`smart_import_meta`** (1:1 with `bank_statement_imports`)

| Column | Type | Notes |
|---|---|---|
| `import_id` | TEXT PK | = `bank_statement_imports.id` |
| `batch_id` | TEXT NOT NULL | groups files applied together |
| `origin` | TEXT NOT NULL | `file`, `sample`, `connector` |
| `format`, `parser` | TEXT NOT NULL | as in 4.6 |
| `account_kind` | TEXT NOT NULL | |
| `account_key` | TEXT NULL | `acct:...` or `label:...` |
| `account_label` | TEXT NULL | user-facing name |
| `account_last4`, `institution` | TEXT NULL | |
| `period_start`, `period_end` | date NULL | |
| `closing_balance` | REAL NULL | |
| `closing_balance_date` | date NULL | |
| `liability_id` | TEXT NULL | soft |
| `txn_new`, `txn_duplicate`, `txn_excluded` | INTEGER NOT NULL DEFAULT 0 | |
| `ai_used` | INTEGER NOT NULL DEFAULT 0 | |
| `ai_provider` | TEXT NULL | display name only |
| `created_at` | datetime | |

**`import_transactions`**

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `import_id` | TEXT NOT NULL | soft, index `ix_import_txn_import` |
| `entity_id` | TEXT NULL | from the batch |
| `account_key` | TEXT NULL | |
| `posted_date` | date NOT NULL | index `ix_import_txn_date` |
| `amount` | REAL NOT NULL | signed, negative is money out |
| `description` | TEXT NOT NULL | masked (4.5) |
| `merchant_key` | TEXT NOT NULL | index `ix_import_txn_merchant` |
| `kind` | TEXT NOT NULL | |
| `category_id` | TEXT NULL | soft |
| `category_source` | TEXT NOT NULL | `user`, `rule`, `seed`, `ai`, `none` |
| `ai_confidence` | REAL NULL | |
| `external_id` | TEXT NULL | FITID |
| `dedupe_key` | TEXT NOT NULL | unique index `ux_import_txn_dedupe` |
| `created_at` | datetime | |

**`merchant_rules`**: `id` TEXT PK, `merchant_key` TEXT NOT NULL (unique index `ux_merchant_rule_key`), `category_id` TEXT NULL, `kind` TEXT NULL, `hits` INTEGER NOT NULL DEFAULT 0, `created_at`, `updated_at`.

**`smart_import_ledger`**: `id` TEXT PK, `import_id` TEXT NOT NULL (index `ix_smart_import_ledger_import`), `action` TEXT NOT NULL (`created`, `linked`, `snapshot`, `balance_moved`), `target_table` TEXT NOT NULL, `target_id` TEXT NOT NULL, `before_json` TEXT NULL, `after_json` TEXT NULL, `created_at`.

Each statement's `bank_statement_imports` row uses existing columns only: `file_name`, `content_hash` = `file_hash` (for the second and later statements of a multi-statement OFX file, `file_hash + ':' + index`), `entity_id`, `row_count` = new transactions, `status='applied'`, `analyzed_at`. Its `UNIQUE(content_hash)` is why Apply skips a file already imported (the wizard has already shown it as all duplicates).

Settings live in `app_settings` under key `smart_import` (JSON: `retention_months` 24, `ai_enabled` false, `pdf_ai_enabled` false, `csv_layouts` {header signature: mapping}, `accounts` {account key: label}) on both paths; per profile on the server, per database file in the browser. `config.yaml` is not used (it is server global).

## 9. Apply and Undo

**Apply** (`POST /api/smart-import/apply`), one transaction (SQLAlchemy session; sql.js `SAVEPOINT` / `RELEASE` with `ROLLBACK TO` on error, building the response before release as project 2 established):

1. For each statement: skip it if its `file_hash` exists (reported as `skipped_files`); insert `bank_statement_imports` and `smart_import_meta`.
2. Insert non-excluded transactions, skipping existing `dedupe_key`s; count new and duplicate.
3. Upsert remembered rules (not ledgered, kept by Undo).
4. Recurring candidates: insert rows; for accepted ones create or link the expense (category, entity from the batch); ledger it.
5. Balance snapshots for linked liabilities (7.3); ledger them.
6. Prune transactions older than `retention_months` by `posted_date`, except those of `origin='sample'` imports (the sample has fixed dates). This is the only automatic delete, and it runs only as part of a user's Apply.
7. Return the import ids and counts.

Every server write calls `check_demo_data_protection()` first, as liabilities does.

**Undo** (`DELETE /api/smart-import/imports/{id}`), one transaction:

1. Delete `import_transactions` where `import_id` matches.
2. Delete the import's `recurring_candidates` rows (before any expense, because `created_expense_id` is a declared foreign key; neither path enables `PRAGMA foreign_keys` today, but the order must not depend on that).
3. For ledgered `created` expenses: delete the expense only if its `name`, `amount`, `frequency`, `category_id` and `is_active` still equal `after_json` and no liability's `expense_id` points at it; otherwise keep it and report it in `kept`. `linked` expenses are never touched.
4. Delete snapshots where `source='import'` and `source_ref` = the import id; then, for each liability with a `balance_moved` ledger row that still exists, set `current_balance` / `balance_as_of` from its newest remaining snapshot (the same rule as `record_balance`, which also respects a later manual balance; `PUT /api/liabilities/{id}` cannot change the balance, so snapshots are the only balance history).
5. Delete the import's `smart_import_ledger` and `smart_import_meta` rows and its `bank_statement_imports` row.
6. Return `{undone: true, deleted: {...counts}, kept: [{table, id, reason}]}`.

"Undo this upload" in the UI undoes each import of a batch, one request per import id. Legacy imports (no meta row) return 404 `not_smart_import`; their candidates keep the legacy accept and reject buttons.

## 10. Endpoints

Data layer (both paths: FastAPI in `src/api/smart_import.py`, LocalAPI in `src/web/src/database/local-smart-import.ts`, `local()` routes):

| Method and path | Purpose |
|---|---|
| `GET /api/smart-import/context` | rules, categories, known accounts, CSV layouts, settings |
| `POST /api/smart-import/preview` | duplicate keys, prior file imports, liability suggestions, recurring history |
| `POST /api/smart-import/apply` | apply a reviewed batch |
| `GET /api/smart-import/imports` | history, newest first, with `batch_id` |
| `DELETE /api/smart-import/imports/{id}` | undo |
| `GET /api/smart-import/rules`, `DELETE /api/smart-import/rules/{id}` | manage remembered merchants |
| `DELETE /api/smart-import/transactions` | delete all stored transaction details (imports, expenses and snapshots stay; Undo still removes those) |
| `GET /api/smart-import/settings`, `PUT /api/smart-import/settings` | retention, AI consent, PDF AI consent, CSV layouts, account labels |
| `GET /api/budget/spending-summary` | planned vs actual by category |

Stateless (server only, used by both modes; `src/api/v2/smart_import.py`; hosted reaches it through the existing `/api/v2/**` PASSTHROUGH):

| Method and path | Purpose |
|---|---|
| `POST /api/v2/smart-import/analyze` | parse one file with context |
| `POST /api/v2/smart-import/recurring` | detect recurring candidates |
| `GET /api/v2/smart-import/status` | hosted AI availability (env key plus flags), limits |
| `POST /api/v2/smart-import/categorize` | AI categorization, env key only, gated by `SMART_IMPORT_AI_ENABLED` |
| `POST /api/v2/smart-import/extract` | AI PDF layout fallback, gated by `SMART_IMPORT_PDF_AI_ENABLED` |

Server-mode AI (FastAPI only; provider registry and the profile's keys; the dispatcher rewrites them to v2 as PAYLOAD routes in hosted mode):

| Method and path | Hosted rewrite |
|---|---|
| `POST /api/smart-import/categorize` | `/api/v2/smart-import/categorize` |
| `POST /api/smart-import/extract` | `/api/v2/smart-import/extract` |
| `GET /api/smart-import/ai-status` | `/api/v2/smart-import/status` |

Server-mode AI also requires the user's consent setting (`ai_enabled`, `pdf_ai_enabled`); the request carries `provider_id` from the Settings select so that select finally means something here.

Rate limiting: add `^/api/smart-import/(categorize|extract)` and `^/api/v2/smart-import/(categorize|extract)` to `AI_ENDPOINT_PATTERNS`. The limiter (active only with `RATE_LIMIT_ENABLED=true` and a secret key) keeps one sliding window per client IP shared by every matched path, default 10 requests per 60 s. A typical import needs one to four categorize calls, which fits; analyze is deliberately **not** added, because a 12-file batch would exhaust the shared window mid-upload. Analyze is bounded by the per-file size, page, text and 20 s caps instead.

Legacy `/api/budget/bank-statements/*` and `/api/v2/bank-statements/parse` keep working unchanged apart from the log line fix; the new UI only uses legacy accept and reject for old pending candidates. Removal is a later cleanup.

## 11. Privacy and security

- **Logs:** smart import code logs event names, import ids, counts, error types and the first 8 hex characters of a file hash. Never file names, descriptions, merchants, amounts, balances, account data, prompts or AI responses. A `caplog` test per endpoint asserts a planted merchant string, amount and file name never appear. The legacy `logger.exception(... filename)` line in `bank_statements.py` changes to log the hash prefix and error type only.
- **Errors:** 4xx and 5xx responses carry a stable `error_type` and a fixed message; no exception text and no row content (`needs_mapping` headers and sample rows are a 200 to the same caller). The UI never renders FastAPI 422 `detail` verbatim.
- **Hosted server:** analyze, recurring, categorize and extract hold content in memory for the request only; uploads are closed in `finally`; no database is opened in any v2 smart-import handler (a test patches `get_database` and `Database` to raise).
- **Nothing kept:** Finlity never writes an uploaded file anywhere; transactions store masked descriptions only; account numbers are hashed.
- **Retention and delete controls:** retention (12, 24 default, 36 months, or keep), "Delete all imported transactions", per-import Undo, per-rule delete.
- **DOM:** imported strings render through `textContent` / `createElement`; no `innerHTML` with data.
- **Demo protection:** every new server write calls `check_demo_data_protection()`.
- **Untrusted files:** section 4.1. OFX never touches an XML parser. PDF: text extraction only, page, text and time caps, encrypted files refused.
- **Bandit and pip-audit:** no new dependency; no XML library, shell call, unsafe deserialization or `eval`; bandit's strict pass on `src/` stays clean with no new `nosec`.

## 12. Connectors, plugins and deferred work

A project 4 connector implements `fetch(since) -> list[NormalizedStatement]` with `origin='connector'`, `format='connector'`, `external_id` set to the aggregator's transaction id (so `dedupe_base` uses it like a FITID) and `file_hash` = SHA-256 of the canonical JSON of that pull. Its output enters at preview; rules, categorization, review, apply, ledger, undo and spending totals are unchanged. A future plugin type `statement_parser` could register a PDF layout or CSV dialect into the parser registry; not built now.

Deferred: opt-in retention of original files, OCR for scanned PDFs, Excel statements, split transactions, editing stored transactions outside the wizard, per-category budget alerts, the hardcoded category ids in the expense modals (1.1), and rate limiting the existing v2 advisor and commentary endpoints (1.3).

## 13. UI

**Entry points.** Budget > Expenses: the "Import Bank Statements" card becomes "Import statements" with the same drop zone and an "Import history" section; its button opens the wizard. Debts page toolbar: "Import statement" opens the wizard with the account kind preset to credit card and the debt link prominent. The dashboard is unchanged in this project.

**Wizard** (`src/web/src/features/smart-import.ts` plus helpers in `src/web/src/utils/smart-import-*.ts`; a `feature-*` chunk; `createDynamicModal({showFooter:false})`, full-screen sheet on phones):

1. **Upload.** Drop zone and file picker (`.csv,.ofx,.qfx,.pdf`, multiple), "Try a sample statement", and the line "Files are read once and never kept. Only masked transactions are saved, in your own database."
2. **Accounts.** One card per statement: detected account (kind, last4, institution, period, transaction count, closing balance), "Which account is this?" when unknown, the column picker when `needs_mapping`, "Amounts look reversed? Flip", the date order switch when `date_order_assumed`, and for card or loan statements the debt link (7.3). A PDF without a readable layout shows the AI fallback card (6.3) or, when unavailable, "Try your bank's CSV or OFX download".
3. **Categorize.** A table: checkbox, date, description, amount, category select, kind, a source chip (Rule, Built-in, AI 92%, You), duplicate badge. Filters: Needs review (default when any), All, Duplicates, Excluded. Sticky bulk bar: set category, set kind, exclude, "Accept all suggestions". Changing a category offers "Remember for all <merchant>". "Suggest with AI" with the "What gets sent" disclosure (6.2); in server mode the first use asks for consent and saves `ai_enabled`. Rows render 200 at a time with "Show more". Keyboard: arrow keys move between rows, space toggles selection.
4. **Recurring bills.** Candidates with tick, name, amount, frequency, category and an "already in your budget" note.
5. **Review.** Counts (new, duplicates, excluded, merchants to remember, expenses to add or link, debt balances with before and after), then Apply.
6. **Done.** Summary, "Undo this import", "See planned vs actual".

**Phone (768 px and below).** The table becomes a card list (description and amount on the first line, category select and chips on the second), the bulk bar sits above the bottom tab bar, and the step label reads "2 of 5".

**Themes.** Existing CSS variables only (`--color-bg-elevated`, `--color-border`, `--color-text-primary`, `--color-text-secondary`, `--color-success`, `--color-error`, `--color-primary`); chips and confidence badges need contrast in both themes.

**Elsewhere.** Budget > Expenses "Planned vs actual" card (7.4). Import history in the Expenses import card with per-upload Undo and its confirm ("Undo this import? Removes 142 transactions, 2 expenses it added and 1 debt balance. Remembered merchants stay."). Settings gets an "Imported transactions" section: retention select, AI suggestions on or off and AI for unreadable PDFs on or off (server mode only), remembered merchants with delete, "Delete all imported transactions".

## 14. Decisions for the operator

1. **Hosted AI spend.** Enabling AI categorization on app.finlity.net spends the operator's Anthropic key for anonymous visitors (one Haiku request per 60 unknown merchants, a few cents per typical import). Default: off (`SMART_IMPORT_AI_ENABLED` unset), so hosted is rules plus manual and the sample needs no AI. Turning it on is a Heroku config var; the rate limiter applies.
2. **Hosted AI PDF fallback** (`SMART_IMPORT_PDF_AI_ENABLED`), the one path that sends masked statement lines to Anthropic through the hosted server. Default: off.

## 15. Testing summary

- Synthetic fixtures in `tests/fixtures/smart_import/`: CSVs (signed amount, debit and credit pair, amount plus type, positive-spending card export, preamble rows, semicolon with decimal comma, D/M dates, no recognizable columns), OFX 1.x SGML and 2.x XML (bank and card, two statements in one file, hostile files with `<!DOCTYPE>` and `<!ENTITY>`), PDFs generated with reportlab at test time (USAA-shaped, generic card, no text layer, 61 pages, encrypted), merchant key and masking cases, recurring cases.
- `tests/fixtures/smart_import_scenario.json` drives apply, undo, rules, settings and spending parity through FastAPI (`TestClient`, temp database) and `tryLocalRoute` (vitest), ids normalized, money within 0.01.
- Migration safety: the liabilities A2 test pattern over the four new tables.
- Security tests: limits, hostile OFX, encrypted PDF, no database access in v2 handlers, `caplog` no-PII assertions, demo protection, AI response validation (garbage, wrong ids, unknown categories), rate limit patterns.
- Layout check (`scripts/check_layout.py`) on `budget`, `debts` and `settings` in server and hosted emulation, 0 problems; screenshots at 390 and 1440 in both themes.
