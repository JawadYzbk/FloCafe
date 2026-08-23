# FloCafe Deep Review — Frontend & Backend

Multi-perspective architecture/security/data/perf/testing review of the working tree.
**Method:** read-only static analysis. ~30 files read in full or in part plus targeted greps across `main/` (70 TS files), `frontend/src/` (148 files), `tests/` (140 suites), CI workflows, and packaging config. No tests or builds were executed; the live `flo.db` was never opened. (A planned 6-agent parallel fan-out failed in this environment; the review was performed directly.)

---

## 0. Applied changes (2026-08-23)

Findings verified against current code (all confirmed accurate) and the following applied. Backend builds clean (`npm run build`, app v3.2.3); relevant suites pass: `cancel-override`, `integration-discount`, `integration-tax`, `integration-lifecycle`, `issue-24`, `integration-happy`, `integration-reconciliation`, `tax-engine`, `tax-components`, `orders-authz`.

- ✅ **Priority 1 — Unified order-total recalculation.** New `main/services/order-recalc.ts` (`recalculateOrderTotals`) is the single Decimal.js (ROUND_HALF_UP) engine. The item **cancel** and **restore** handlers in `routes/index.ts` now both call it, deleting ~160 lines of duplicated raw-float recalculation (A-2) and removing the float-drift path (C-1). Behavior preserved (verified by the suites above).
- ✅ **C-2 snapshot leak.** Both handlers now pass `currentOrder.delivery_charge`/`packaging_charge` (transaction-local) to `syncUnpaidBillsForOrder` instead of the pre-transaction `order.*` snapshot.
- ✅ **A-P2 hardcoded health version.** `server.ts` now resolves the version via `getAppVersion()` (reads `package.json`, the pattern already used by cloud-sync/support-ticket/tax-packs) instead of the stale `'2.4.7'` fallback.
- ✅ **B-LOW health info disclosure.** `/api/health` no longer returns raw `db.error` text to unauthenticated callers — reports `db: 'error'` only.

Remaining priorities below are unaddressed (larger/structural or product decisions): split `main/db.ts` (A-1), break up `settings/page.tsx` (D-1), Electron renderer sandbox (B-MEDIUM), axios default timeouts (D-P2), Windows-friendly test runners (F-P2).

---

## 1. Executive summary

FloCafe is an unusually **mature, security-conscious offline-first POS**. The evidence of hard-won fixes is everywhere: GHSA/vuln-ID annotated code, fail-closed revocation lookups, unconditional pre-migration backups, per-migration transactions, runtime-derived CI test shards, and a tax invariant job that runs on every push. Core invariants from `AGENTS.md` (offline-first, backend-authoritative tax/auth, timestamp conventions, data safety) are visibly honored in the reviewed paths.

The debt that remains is concentrated and structural rather than scattered:

1. **Monolith hotspots** — `main/db.ts` (5,125 lines) and `frontend/src/app/(dashboard)/settings/page.tsx` (4,506 lines) are doing too many jobs.
2. **Two parallel order-total engines** — the inline cancel/restore handlers in `routes/index.ts` re-implement ~450 lines of tax/discount recalculation with raw float math, while `services/tax*.ts` does the same job correctly with Decimal.js.
3. **Electron renderer `sandbox: false`** — the last meaningful hardening gap on an otherwise tight shell.

| Perspective | Grade | One-line verdict |
| --- | --- | --- |
| Backend architecture | B+ | Clean layering & lifecycle; hub-file bloat and mixed error styles |
| Security posture | A− | Genuinely hardened LAN surface; minor info-leaks, `sandbox: false` |
| Data layer & migrations | A− | Best-in-class migration discipline; float-money recalc path is the outlier |
| Frontend architecture | B | Smart seams (LAN-origin API, RTL, i18n); god-components, no fetch timeouts |
| Performance & resilience | B+ | Timeboxed printers, backoff+REST fallback, memory-bounded caches; sync SQLite on hot loop |
| Testing & release | A− | 140 suites + issue-regression culture + strong CI; bash-gated scripts on Windows |

---

## 2. Findings by perspective

### A. Backend architecture & code quality

- **[P1] `main/db.ts` is a 5,125-line monolith.** It contains maintenance-lock orchestration (lines 13–130), backup/restore/import (~lines 1300–4000), the migration engine (`runMigrations()` at :4025), full schema DDL (:4078+), and query helpers (`now()`, `parseItemJson`, `withTxn`, …). Every concern in the backend funnels through one file. *Fix:* split into `main/db/{connection,maintenance,migrations,backup,schema,helpers}.ts` keeping the public export surface identical (pure mechanical re-export first, no behavior change).
- **[P1] `routes/index.ts` duplicates the entire item-cancel recalculation.** `PATCH …/items/:id/cancel` (:256–540) and `PATCH …/items/:id/restore` (:543–704) contain near-verbatim copies of stock restore rules, discount scaling, tax rollup, bill resync, and table freeing. Any policy change must be made twice — they already drifted once (`order.` vs `currentOrder.`, see C below). *Fix:* extract a `services/order-recalc.ts` used by both, then delete ~250 lines.
- **[P2] Three coexisting error-handling styles.** `asyncHandler` (good, integrates with shutdown tracking), manual `try/catch` + `console.error("[API] Internal error")` repeated per-route, and the central error handler in `server.ts:253`. Standardize on `asyncHandler` + errors carrying `statusCode`; let the global handler format responses.
- **[P2] Hardcoded version fallback.** `server.ts:198` reports `'2.4.7'` when `npm_package_version` is unset — which is *always* the case in the packaged Electron app (app is v3.2.3). Health-check consumers see a wrong version. Read it from `app.getVersion()`.
- **[P2] Silent port drift.** On `EADDRINUSE` the server walks up to 10 ports (`server.ts:337–353`). Companion devices discover the port dynamically, so it works, but nothing surfaces the relocation loudly. Log a persistent warning and expose the effective port in `pos-info`/`get-status` (verify it already does).

### B. Security posture

Verified strengths (each checked in code): global `requireAuth` over `/api/*` with role re-read from DB (not JWT claim) and short-TTL cache (`server.ts:35–82`, `middleware/security.ts:154–193`); token revocation persisted as SHA-256 hashes that **fail closed** on lookup errors (`security.ts:281–300`); stale-token rejection after password/PIN change (#173, `security.ts:217–227`); CORS limited to localhost/LAN/`.local` (`security.ts:440–457`); Host-header-validated CSP (`csp.ts`); PIN override rate-limits keyed per-client-per-action, not per-item (GHSA-9jjq-2fmw-x3mw, `routes/index.ts:349–356`); KDS WebSocket: 5s auth timeout, 100-client cap, 25 unauth cap, fresh revocation check per connection (`services/kds.ts:24–27`); setup endpoints restricted to loopback hosts (`routes/auth.ts:35`).

Findings:

- **[MEDIUM] Renderer `sandbox: false`** (`main/index.ts:261`) with `contextIsolation: true, nodeIntegration: false`. The preload surface is already a narrow allowlist (`preload.ts`), which is exactly the shape that supports enabling the Chromium sandbox. This is the highest-value remaining Electron hardening step.
- **[LOW] Unauthenticated product-image GET** (`server.ts:43`) lets any LAN device enumerate menu imagery without credentials. Deliberate (`<img>` ergonomics) — consider a signed-URL option later.
- **[LOW] Health endpoint discloses internals** (`server.ts:192–201`): raw `db.error` text and version to unauthenticated callers. Return `{status:"error"}` without detail publicly.
- **[LOW] JWT secret lives plaintext in the `settings` table** (`routes/auth.ts:58–78`). Acceptable for a local-first product (the DB is the crown jewel anyway); document the threat model, optionally wrap with OS keychain.
- **[LOW] Session token in `localStorage`** + `script-src 'unsafe-inline'` CSP. Standard SPA tradeoff; a nonce/hash-based CSP would materially reduce XSS blast radius if ever pursued.
- **[INFO]** Auto-updater downloads silently but installs only on explicit action (`index.ts:77–78`) — correct choice for a POS mid-payment.

### C. Data layer & migrations

Verified strengths: every migration runs inside `db.transaction(() => { up(); pragma(user_version) })` (`db.ts:4064–4067`); an **unconditional auto-backup fires before any pending batch** (`db.ts:4045–4058`) including ancient `user_version 0` installs; downgrade attempts throw `SchemaVersionMismatchError` loudly instead of half-running (`db.ts:4029–4035`); backup/restore serialize through a FIFO maintenance lock with drain timeouts; `withTxn` is used 35× across routes for multi-statement writes; canonical `now()`/`parseDbTimestamp` UTC helpers are consistently referenced (incl. the whole-second stale-token comparison). Test coverage matches the AGENTS verification matrix (`upgrade-path`, `schema-health`, `migration-v56-to-v57`, `migration-v71-repair`, `audit:db`).

Findings:

- **[P1→P2] Float money math in the cancel/restore recalc** (`routes/index.ts:421–459` and `607–646`): `Math.round(subtotal * pct / 100 * 100) / 100` and proportional `taxRatio` scaling, versus Decimal.js with explicit cent reconciliation in `services/tax.ts` / `tax-components.ts` (ROUND_HALF_UP, `centsDelta` redistribution). Two sources of truth for order totals; the float one can drift cents on odd discounts. Fixing this is the same refactor as finding A-2.
- **[P2] Pre-transaction snapshot leaks into bill sync.** Both handlers call `syncUnpaidBillsForOrder(... deliveryCharge: order.delivery_charge ...)` using `order` fetched *before* `withTxn` (`routes/index.ts:515`, `:684`) — directly contradicting the adjacent comment that all mutation decisions use transaction-local rows. Use `currentOrder`.
- **[P3] `products.price REAL` at rest** (`db.ts:4103`). Computation is Decimal-guarded, but integer-minor-units storage would eliminate the class of bug permanently. Long-term, migration-gated.

### D. Frontend architecture & UX engineering

Verified strengths: API base URL derived from `window.location.origin` so LAN tablets talk to the right host (`lib/api.ts:11–17`) with KDS-aware 401 handling that avoids stranding station screens (`api.ts:34–49`); focused Zustand stores with real domain logic (cart line-identity normalization/merging in `store/cart.ts` + `lib/cart-identity`); KDS reconnect uses bounded exponential backoff 1s→30s and has a REST degradation mode (`hooks/useKdsConnection.ts:9–22`); RTL done with logical properties (`start/end`, `border-s`) and deliberate `rtl:` animation flips; i18n backed by translation/locale-chunk/RTL test suites; no hardcoded `localhost:3001` anywhere in `frontend/src`.

Findings:

- **[P1] God-components.** `settings/page.tsx` **4,506 lines**, `orders/page.tsx` 1,686, `TaxConfigurationPanel.tsx` 1,379, `products/page.tsx` 1,236, `pos/page.tsx` 1,031. The settings page alone spans business, tax, printers, kitchen, KDS, loyalty… Extract per-section panel components (the repo already has `components/settings/` as the home for them).
- **[P2] No default axios timeout** (`lib/api.ts:11–17`). A wedged request hangs UI flows forever; combined with the synchronous backend under load, set a sane default (e.g. 15–30s) and use `AbortController` in effect-driven fetches.
- **[P3] Zoom disabled**: `maximumScale: 1, userScalable: false` (`app/layout.tsx:50–51`) fails WCAG 1.4.4 for low-vision users on companion devices.
- **[P3] Cart is not persisted** (`store/cart.ts` has no `persist`). A browser refresh mid-order silently loses the ticket unless staff know the hold-order flow. Confirm intent; if deliberate, guard with an beforeunload warning.
- **[NOTE]** Single `dangerouslySetInnerHTML` (`app/layout.tsx:70–80`) injects a constant service-worker registration string — safe.

### E. Performance & offline resilience

Verified strengths: every printer detection/exec path carries explicit timeouts (5–20s) and abort signals (`printers/thermal.ts:158–2093`); rate-limit and auth-cache maps self-prune with size bounds (`middleware/security.ts:52–59`, `:160–168`); KDS caps concurrent/unauthenticated clients; graceful-shutdown coordinator tracks in-flight HTTP work and drains DB requests with hard timeouts (`db.ts:73–130`, `shutdown.ts`); optional services (WhatsApp init, cloud sync, updater 404s) all fail soft with logged non-fatals.

Findings:

- **[P2] Synchronous better-sqlite3 on the server event loop.** Heavy exports (menu CSV) and report scans run inline on the same loop that streams KDS updates; a big export stalls kitchen screens. Measure first; if confirmed, move bulk exports/report aggregation to `worker_threads` with a read-only connection.
- **[P3] Leading-wildcard customer search** (`routes/index.ts:210–214`) can't use an index; fine at `LIMIT 20` single-store scale, revisit if CRM grows.
- **[NOTE]** WAL sidecar files present in dev root; combined with `kill-ports.js` cleanup and the drain-timeout design, long-shift WAL growth looks managed, but this review did not stress-test disk-full behavior.

### F. Testing & release readiness

Verified strengths: 140 suites spanning unit/integration/regression with named issue suites acting as institutional memory (issue-24 → issue-266); migration verification exactly per the AGENTS matrix; CI (`ci.yml`) uses SHA-pinned actions, path-filtered jobs, an **always-on tax-category-invariant job**, and test shards **derived from `package.json` at runtime** so shard coverage cannot drift; native-module rebuild step for `better-sqlite3`; Playwright e2e job; five packaging targets incl. MAS fastlane pipeline; `run-test.sh` exit-77 ABI-skip convention documented.

Findings:

- **[P2] Bash-gated test entrypoints on Windows.** Nearly every npm test chains `bash tests/run-test.sh` — on the project's own primary dev platform (Windows checkout) this silently requires Git-Bash/WSL PATH setup. Provide `.cjs` fallback wrappers or document the requirement in CONTRIBUTING.
- **[P3] e2e runs Chromium only** (`test:e2e`). KDS tablets in the wild are assorted Android/iOS browsers; a WebKit smoke would catch Safari-specific breakage.
- **[NOTE]** Full-suite wall time is mitigated by sharding per CI comments (~3.5 min serial claim); not independently verified here.

---

## 3. Top priorities (cross-cutting)

1. ✅ **Unify order-total recalculation** into one Decimal.js-based service consumed by cancel/restore — kills the duplication (A-2), the float-math drift (C-1), and the snapshot leak (C-2) in one refactor. *(Applied — see §0. Extended to orders/bills paths is still open.)*
2. **Split `main/db.ts`** behind an unchanged public API (A-1).
3. **Break up `settings/page.tsx`** into section components (D-1).
4. **Enable Electron renderer sandbox** (B-MEDIUM).
5. **Add axios default timeouts + aborts** (D-P2).
6. ✅ Fix hardcoded health-version and health error disclosure (A/B LOWs) — one-hour fix batch. *(Applied — see §0.)*
7. Windows-friendly test runners (F-P2).

---

## 4. Limitations

- Static sampling, not exhaustive: deep reads concentrated on bootstrap, auth/security middleware, migrations, order-cancel paths, KDS realtime, printing failure paths, frontend stores/client, CI. Files like `reports.ts`, `bills.ts` (2,200+ lines), `whatsapp.ts`, `google-drive.ts` were only grepped or untouched.
- No dynamic verification: tests, builds, and lint were **not** executed (out of scope for this pass); performance claims are structural inferences, not measurements.
- The live database was never opened; index coverage was assessed indirectly via the existence of `schema-health`/`db-audit` tooling, not by query planning.
