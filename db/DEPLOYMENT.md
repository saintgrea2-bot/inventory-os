# Deployment Runbook — Normalized Schema v2 + Neon Authorization

Target environment: **Neon Postgres** (prod branch) serving the Inventory
Management App (Express + `pg`, deployed via Vercel services).

This deployment is **additive and non-breaking**: the legacy
`unified_inventory_history` table is preserved, so the running app
(`routes/inventory.js`, `public/app.js`) keeps working unchanged. The new
normalized tables, views, roles, and RLS policies are created alongside.
Full app cutover (rewriting queries to the new tables) is a separate
follow-up and is **not** required for this deployment to be safe.

---

## 0. Prerequisites

| Tool | Check | Install if missing |
|------|-------|--------------------|
| `psql` (libpq ≥ 14) | `psql --version` | Neon CLI bundles it, or `winget install PostgreSQL.PostgreSQL` |
| Neon CLI | `neon --version` | `npm i -g @neondatabase/neonctl` then `neon auth` |
| Node 18+ | `node -v` | already required by the app |
| `pg_dump` | `pg_dump --version` | ships with Postgres |

Confirm you can reach the prod database:
```powershell
psql "$env:DATABASE_URL" -c "SELECT version();"
```
If `DATABASE_URL` is not in your shell, copy it from the Neon dashboard
(**Connection Details → Direct connection**, *not* the pooled/PgBouncer one —
DDL must run on the direct endpoint).

---

## 1. Pre-deployment checks

1. **Identify the direct (non-pooled) endpoint.** In Neon: project →
   connection string labeled *Direct*. Pooled endpoints reject session
   commands like `SET LOCAL` and some DDL. Use direct for steps 3–5; the
   app keeps using pooled at runtime.
2. **Confirm low traffic / no in-flight rentals.** Check the dashboard or:
   ```sql
   SELECT COUNT(*) FROM unified_inventory_history
   WHERE action_type = 'Rental Out' AND created_at > NOW() - INTERVAL '5 minutes';
   ```
   Expect `0` before proceeding.
3. **Prepare four strong role passwords** (store in a secret manager, not
   the repo): `RO_PW`, `INV_PW`, `RENT_PW`, `ADM_PW`.
4. **Sanity-check the new SQL parses** locally without touching Neon:
   ```powershell
   psql -X -v ON_ERROR_STOP=1 -f db/schema_normalized.sql "postgres://nobody:nobody@127.0.0.1:5432/dummy" 2>&1 | Select-String "syntax error"
   ```
   (Any non-syntax connection error is fine; you are looking for *no*
   `syntax error` lines.)
5. **Note the `setup-db.js` limitation.** Its `sql.split(';')` splitter
   cannot handle plpgsql `$$` blocks, so `npm run setup` must **not** be
   used for v2. Use `psql` directly as shown below.

---

## 2. Create a Neon preview branch

Work on a branch first; promote only after verification.

```powershell
# from the repo root
neon branches create --name schema-v2 --parent main
neon connection-string schema-v2   # prints BRANCH_URL — copy it
```

Set it in your shell for this session:
```powershell
$env:BRANCH_URL = "<paste branch connection string>"
```

---

## 3. Apply the normalized schema (on the branch)

```powershell
psql -X -v ON_ERROR_STOP=1 -1 -f db/schema_normalized.sql "$env:BRANCH_URL"
```

- `-1` runs everything in a single transaction (all-or-nothing).
- `ON_ERROR_STOP=1` aborts on the first error.

Expected last line: `Schema created successfully` / `Normalized schema v2 created successfully`.

---

## 4. Apply authorization (roles, grants, RLS)

```powershell
psql -X -v ON_ERROR_STOP=1 -1 `
  -v ro_pw=$env:RO_PW  -v inv_pw=$env:INV_PW `
  -v rent_pw=$env:RENT_PW -v adm_pw=$env:ADM_PW `
  -f db/authorization.sql "$env:BRANCH_URL"
```

Expected last line: `Authorization policies applied successfully`.

> If a role already exists from a prior partial run, replace `CREATE ROLE`
> with `ALTER ROLE ... PASSWORD` in `db/authorization.sql`, or drop the
> branch and restart from step 2.

---

## 5. Backfill data from the legacy table

```powershell
psql -X -v ON_ERROR_STOP=1 -f db/migrate_v1_to_v2.sql "$env:BRANCH_URL"
```

This is **read-only** against `unified_inventory_history` and idempotent
(`ON CONFLICT`). It populates `items`, `customers`, `stock_movements`,
`item_lifecycle_events`, and `rentals`, then prints row counts.

---

## 6. Verification (on the branch)

Run each block against `$env:BRANCH_URL`.

### 6a. Object inventory
```sql
\dt+                 -- expect: items, stock_movements, item_lifecycle_events,
                     --         customers, rentals, audit_log, shops (+ legacy)
\dv+                 -- expect: v_item_stock, v_item_current_status,
                     --         v_item_profit, v_unified_inventory_history
```

### 6b. Row-count parity
```sql
SELECT (SELECT COUNT(DISTINCT item_sku) FROM unified_inventory_history) AS legacy_skus,
       (SELECT COUNT(*) FROM items)                                    AS new_items;
-- the two counts MUST match
```

### 6c. Derived views return data
```sql
SELECT * FROM v_item_stock LIMIT 5;
SELECT * FROM v_item_current_status LIMIT 5;
SELECT * FROM v_unified_inventory_history LIMIT 5;   -- legacy-shape compat view
```

### 6d. RLS enforces shop scope
```powershell
# connect as a bridal clerk and scope the session
psql -v ON_ERROR_STOP=1 "$env:BRANCH_URL" -c "SET ROLE rental_clerk; SET LOCAL app.shop_code = 'Bridal'; SELECT COUNT(*) FROM items;"
psql -v ON_ERROR_STOP=1 "$env:BRANCH_URL" -c "SET ROLE rental_clerk; SET LOCAL app.shop_code = 'Bags';   SELECT COUNT(*) FROM items;"
```
The Bridal session should return only Bridal rows; the Bags session only
Bags rows. A clerk with no `app.shop_code` set should see `0` rows
(policy `USING` returns false).

### 6e. Audit trigger fires
```sql
SET ROLE app_admin;
UPDATE items SET sell_price = sell_price WHERE item_sku = (SELECT item_sku FROM items LIMIT 1);
SELECT * FROM audit_log ORDER BY id DESC LIMIT 1;
RESET ROLE;
```
Expect one new `audit_log` row with `action = 'U'`.

### 6f. App still works against the branch
Point a local copy of the app at the branch and smoke-test:
```powershell
$env:DATABASE_URL = $env:BRANCH_URL
npm start
# then hit http://localhost:3000 and confirm the dashboard loads
```

---

## 7. Promote to production

Once 6a–6f pass on the branch:

```powershell
neon branches promote schema-v2
```

Neon atomically swaps the branch to become `main`; the old main is
retained as a restore point. Update the Vercel `DATABASE_URL` env var
only if you changed endpoints (you usually do not — promotion keeps the
same project).

---

## 8. Post-deployment configuration updates

1. **Vercel env vars** (Project → Settings → Environment Variables):
   add the four role connection strings (or keep a single app role and
   rely on RLS). Redeploy: `vercel --prod`.
2. **`db/pool.js`** already sets `ssl: { rejectUnauthorized: false }`.
   For stricter validation, replace with the Neon CA cert:
   ```js
   ssl: { ca: fs.readFileSync('neon-ca.crt'), rejectUnauthorized: true }
   ```
3. **Optional cutover** (separate PR, not required for safety): rewrite
   `routes/inventory.js` INSERT/SELECT paths to target the new tables and
   `v_*` views instead of `unified_inventory_history`.

---

## 9. Rollback

### Case A — not yet promoted (still on branch)
```powershell
neon branches delete schema-v2
```
Prod is untouched; nothing to revert.

### Case B — promoted, issue discovered quickly
Neon keeps the previous main as a restore point, and the deployment was
**additive** (legacy table intact), so:

1. **App-level rollback (fastest):** the app still reads/writes
   `unified_inventory_history`, which is unchanged. Just revert any
   Vercel env-var changes from step 8 and redeploy. The new tables/views
   can remain dormant.
2. **Full schema rollback:** drop the v2 objects (run against prod):
   ```powershell
   psql -X -v ON_ERROR_STOP=1 "$env:DATABASE_URL" -c @"
   DROP VIEW IF EXISTS v_unified_inventory_history;
   DROP VIEW IF EXISTS v_item_profit;
   DROP VIEW IF EXISTS v_item_current_status;
   DROP VIEW IF EXISTS v_item_stock;
   DROP TABLE IF EXISTS rentals;
   DROP TABLE IF EXISTS customers;
   DROP TABLE IF EXISTS item_lifecycle_events;
   DROP TABLE IF EXISTS stock_movements;
   DROP TABLE IF EXISTS audit_log;
   DROP TABLE IF EXISTS items;
   DROP TABLE IF EXISTS shops;
   DROP FUNCTION IF EXISTS fn_touch_updated_at();
   DROP FUNCTION IF EXISTS fn_audit_items();
   -- roles + RLS policies are dropped with their tables; drop login roles:
   DROP ROLE IF EXISTS rental_clerk;
   DROP ROLE IF EXISTS inventory_mgr;
   DROP ROLE IF EXISTS app_readonly;
   DROP ROLE IF EXISTS app_admin;
   DROP ROLE IF EXISTS r_read;
   DROP ROLE IF EXISTS r_write;
   "@
   ```
3. **Point-in-time recovery (last resort):** if the legacy table was
   damaged, reset prod to a pre-deployment state:
   ```powershell
   neon branches reset main --to "2026-07-19T09:00:00Z"
   ```
   Use a timestamp from *before* step 3.

### Case C — data corruption in new tables only
Re-run the migration from a clean slate (the new tables are derived from
the legacy table, which is the source of truth):
```powershell
psql -X -v ON_ERROR_STOP=1 "$env:DATABASE_URL" -c "TRUNCATE items, stock_movements, item_lifecycle_events, customers, rentals RESTART IDENTITY CASCADE;"
psql -X -v ON_ERROR_STOP=1 -f db/migrate_v1_to_v2.sql "$env:DATABASE_URL"
```

---

## 10. Quick reference — command sequence

```powershell
# 0. prep
neon auth
$env:BRANCH_URL = neont branches create --name schema-v2 --parent main | Select-String "connection"  # or copy from dashboard

# 1-5. deploy to branch
psql -X -v ON_ERROR_STOP=1 -1 -f db/schema_normalized.sql     "$env:BRANCH_URL"
psql -X -v ON_ERROR_STOP=1 -1 -v ro_pw=$env:RO_PW -v inv_pw=$env:INV_PW -v rent_pw=$env:RENT_PW -v adm_pw=$env:ADM_PW -f db/authorization.sql "$env:BRANCH_URL"
psql -X -v ON_ERROR_STOP=1    -f db/migrate_v1_to_v2.sql      "$env:BRANCH_URL"

# 6. verify (see section 6 queries)

# 7. promote
neon branches promote schema-v2
```
