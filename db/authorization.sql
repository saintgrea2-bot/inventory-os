-- =============================================================
-- Neon Authorization & Access-Control Protocols
-- PostgreSQL roles, grants, and Row-Level Security policies for the
-- normalized inventory/rental schema. Run after schema_normalized.sql.
--
-- Neon specifics:
--   * Neon enforces TLS on every connection (sslmode=require).
--   * Auth is SCRAM-SHA-256; never store plaintext passwords.
--   * Use Neon's PgBouncer endpoint (port 5432 pooler) for app traffic
--     and the direct endpoint for migrations/DDL.
--   * Use Neon branches for staging/preview; promote via PR merge.
--   * Rotate credentials via Neon dashboard or `neon roles` CLI.
-- =============================================================

-- ---------- 1. Roles (application-level principals) ----------
-- Create login roles with strong SCRAM-SHA-256 passwords. Pass passwords
-- in via psql variables so they never appear in the repo:
--   psql "$DATABASE_URL" -v ro_pw=... -v inv_pw=... -v rent_pw=... -v adm_pw=... -f db/authorization.sql
-- On existing DBs prefer ALTER ROLE ... PASSWORD rather than recreating.
-- Idempotent: create if absent, else rotate the password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_readonly')  THEN CREATE ROLE app_readonly  LOGIN PASSWORD :ro_pw;   ELSE ALTER ROLE app_readonly  LOGIN PASSWORD :ro_pw;   END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='inventory_mgr') THEN CREATE ROLE inventory_mgr LOGIN PASSWORD :inv_pw;   ELSE ALTER ROLE inventory_mgr LOGIN PASSWORD :inv_pw;   END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rental_clerk')  THEN CREATE ROLE rental_clerk  LOGIN PASSWORD :rent_pw;  ELSE ALTER ROLE rental_clerk  LOGIN PASSWORD :rent_pw;  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_admin')     THEN CREATE ROLE app_admin     LOGIN PASSWORD :adm_pw;    ELSE ALTER ROLE app_admin     LOGIN PASSWORD :adm_pw;    END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='r_read')        THEN CREATE ROLE r_read  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='r_write')       THEN CREATE ROLE r_write NOLOGIN; END IF;
END $$;

GRANT r_read TO app_readonly, inventory_mgr, rental_clerk, app_admin;
GRANT r_write TO inventory_mgr, rental_clerk, app_admin;

-- ---------- 2. Schema & table privileges ----------
-- Default privileges: revoke all, then grant least privilege.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO r_read, r_write;

-- Read access to every table + sequences for the read group.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO r_read;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO r_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO r_read;

-- Write group: full DML on transactional tables, limited on master data.
GRANT INSERT, UPDATE, SELECT ON items, stock_movements, item_lifecycle_events,
     customers, rentals TO r_write;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO r_write;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT INSERT, UPDATE, SELECT ON TABLES TO r_write;

-- DDL / migration role (app_admin) — also gets DELETE + TRUNCATE.
GRANT DELETE, TRUNCATE ON items, stock_movements, item_lifecycle_events,
     customers, rentals TO app_admin;

-- ---------- 3. Row-Level Security ----------
-- Enable RLS on tables that carry shop-scoped or customer-scoped rows.
ALTER TABLE items                ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rentals              ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers            ENABLE ROW LEVEL SECURITY;

-- App_admin bypasses RLS (full access for migrations/support).
-- Best-effort: some Neon plans restrict BYPASSRLS for non-superusers.
DO $$
BEGIN
  ALTER ROLE app_admin BYPASSRLS;
EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN
  RAISE NOTICE 'BYPASSRLS not permitted on this Neon plan; app_admin will rely on explicit grants only';
END $$;

-- Session variable `app.shop_code` is set on connect (SET LOCAL app.shop_code = 'Bridal')
-- to scope a clerk's session to their shop.

-- items: readable by shop; writable by inventory_mgr of the same shop.
CREATE POLICY p_items_read_shop  ON items FOR SELECT TO r_read
    USING (shop_code = current_setting('app.shop_code', true));
CREATE POLICY p_items_write_shop ON items FOR ALL    TO inventory_mgr
    USING (shop_code = current_setting('app.shop_code', true))
    WITH CHECK (shop_code = current_setting('app.shop_code', true));

-- stock_movements: scoped via the parent item's shop.
CREATE POLICY p_stock_shop ON stock_movements FOR ALL TO r_write
    USING (item_sku IN (
        SELECT item_sku FROM items
        WHERE shop_code = current_setting('app.shop_code', true)))
    WITH CHECK (item_sku IN (
        SELECT item_sku FROM items
        WHERE shop_code = current_setting('app.shop_code', true)));

CREATE POLICY p_life_shop ON item_lifecycle_events FOR ALL TO r_write
    USING (item_sku IN (
        SELECT item_sku FROM items
        WHERE shop_code = current_setting('app.shop_code', true)))
    WITH CHECK (item_sku IN (
        SELECT item_sku FROM items
        WHERE shop_code = current_setting('app.shop_code', true)));

-- rentals: clerks see/modify only rentals for items in their shop.
CREATE POLICY p_rentals_shop ON rentals FOR ALL TO r_write
    USING (item_sku IN (
        SELECT item_sku FROM items
        WHERE shop_code = current_setting('app.shop_code', true)))
    WITH CHECK (item_sku IN (
        SELECT item_sku FROM items
        WHERE shop_code = current_setting('app.shop_code', true)));

-- customers: a clerk can read customers who have a rental in their shop;
-- any r_write principal may insert/update a customer record.
CREATE POLICY p_customers_read ON customers FOR SELECT TO r_read
    USING (id IN (
        SELECT customer_id FROM rentals
        WHERE item_sku IN (SELECT item_sku FROM items
                           WHERE shop_code = current_setting('app.shop_code', true))));
CREATE POLICY p_customers_write ON customers FOR INSERT TO r_write WITH CHECK (true);
CREATE POLICY p_customers_update ON customers FOR UPDATE TO r_write USING (true);

-- ---------- 4. Audit ----------
-- All write tables already carry created_by DEFAULT CURRENT_USER.
-- Add a generic audit trail for sensitive UPDATE/DELETE on items.
CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    table_name TEXT   NOT NULL,
    row_pk     TEXT   NOT NULL,
    action     VARCHAR(10) NOT NULL,           -- UPDATE / DELETE / INSERT
    changed_by NAME   NOT NULL DEFAULT CURRENT_USER,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    old_data   JSONB,
    new_data   JSONB
);

CREATE OR REPLACE FUNCTION fn_audit_items()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_log(table_name, row_pk, action, old_data, new_data)
    VALUES ('items', OLD.item_sku, TG_OP,
            to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_items ON items;
CREATE TRIGGER trg_audit_items AFTER UPDATE OR DELETE ON items
    FOR EACH ROW EXECUTE FUNCTION fn_audit_items();

GRANT INSERT ON audit_log TO r_write;
GRANT SELECT ON audit_log TO app_admin;

-- ---------- 5. Connection hardening reminders ----------
-- 1. App connects with sslmode=require&sslrootcert=<neon-ca> via PgBouncer
--    pooler endpoint; never use the direct endpoint for runtime queries.
-- 2. Store credentials in Neon's web proxy / Vercel env vars, not in repo.
-- 3. Rotate role passwords quarterly; use `neon roles rotate <role>`.
-- 4. Use Neon branches for preview deploys; never run migrations on prod
--    branch from a CI role that lacks BYPASSRLS.
-- 5. Set `SET LOCAL app.shop_code` inside a single transaction so RLS
--    policies cannot leak across shop scope on pooled connections.

SELECT 'Authorization policies applied successfully' AS status;
