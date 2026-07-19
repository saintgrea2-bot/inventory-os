-- =============================================================
-- Inventory Management System — Normalized Schema (v2)
-- Separates inventory (items + stock ledger + lifecycle) from
-- rental transactions (customers + bookings + returns).
--
-- Run against Neon / Postgres:
--   psql "$DATABASE_URL" -f db/schema_normalized.sql
--
-- Conventions:
--   * Surrogate BIGIDENTITY PKs on transaction tables.
--   * Natural key item_sku (UNIQUE) as the business identifier.
--   * All money in ETB (DECIMAL(10,2)).
--   * All mutating tables carry created_at + created_by for audit.
-- =============================================================

-- ---------- Extensions ----------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() for customers

-- ---------- 1. Shops (lookup) ----------
CREATE TABLE IF NOT EXISTS shops (
    shop_code    VARCHAR(20) PRIMARY KEY
                    CHECK (shop_code IN ('Bags', 'Bridal')),
    description  VARCHAR(255)
);

INSERT INTO shops (shop_code, description) VALUES
    ('Bags',   'Bags retail and resale'),
    ('Bridal', 'Bridal wear retail and rental')
ON CONFLICT (shop_code) DO NOTHING;

-- ---------- 2. Items (inventory master) ----------
-- One row per physical SKU. Holds static descriptive + pricing data.
CREATE TABLE IF NOT EXISTS items (
    item_sku         VARCHAR(100) PRIMARY KEY,
    shop_code        VARCHAR(20)   NOT NULL REFERENCES shops(shop_code),
    item_name        VARCHAR(255)  NOT NULL,
    brand_designer   VARCHAR(100),
    item_image       TEXT,

    stock_cost_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    sell_price       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    -- gross_profit / margin computed in views; not stored to avoid drift.

    min_stock_alert  INT           NOT NULL DEFAULT 2,
    -- Sparse shop-specific attributes kept here (NULLable) rather than
    -- forcing a class-table inheritance; only ~2 variants exist.
    bag_color        VARCHAR(50),
    bridal_size      VARCHAR(50),

    is_active        BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_item_price CHECK (sell_price >= 0 AND stock_cost_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_items_shop   ON items(shop_code);
CREATE INDEX IF NOT EXISTS idx_items_name   ON items(item_name);

-- ---------- 3. Stock ledger (inventory movements) ----------
-- Append-only ledger of stock-affecting events. Current stock =
--   SUM(quantity_change) for a given item_sku.
CREATE TABLE IF NOT EXISTS stock_movements (
    id              BIGSERIAL PRIMARY KEY,
    item_sku        VARCHAR(100) NOT NULL REFERENCES items(item_sku),
    action_type     VARCHAR(50)  NOT NULL
                      CHECK (action_type IN ('New Item', 'Restock', 'Retail Sale', 'Adjustment')),
    quantity_change INT          NOT NULL,          -- +in / -out
    unit_cost_price DECIMAL(10,2),                  -- snapshot if relevant
    notes           TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by      VARCHAR(100) NOT NULL DEFAULT CURRENT_USER
);

CREATE INDEX IF NOT EXISTS idx_stock_sku_time ON stock_movements(item_sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_action   ON stock_movements(action_type);

-- ---------- 4. Item lifecycle (bridal non-rental status) ----------
-- Tracks bridal states that are NOT rentals: Available, In Alteration,
-- Dry Cleaning, Sold. Rental state lives in the rentals table instead,
-- so bridal_status is derived (see view v_item_current_status).
CREATE TABLE IF NOT EXISTS item_lifecycle_events (
    id          BIGSERIAL PRIMARY KEY,
    item_sku    VARCHAR(100) NOT NULL REFERENCES items(item_sku),
    status      VARCHAR(50)  NOT NULL
                  CHECK (status IN ('Available', 'In Alteration', 'Dry Cleaning', 'Sold')),
    notes       TEXT,
    occurred_at TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recorded_by VARCHAR(100) NOT NULL DEFAULT CURRENT_USER
);

CREATE INDEX IF NOT EXISTS idx_life_sku_time ON item_lifecycle_events(item_sku, occurred_at DESC);

-- ---------- 5. Customers ----------
-- Replaces the free-text customer_name_contact column.
CREATE TABLE IF NOT EXISTS customers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name VARCHAR(255) NOT NULL,
    phone        VARCHAR(50),
    email        VARCHAR(255),
    notes        TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by   VARCHAR(100) NOT NULL DEFAULT CURRENT_USER,

    CONSTRAINT chk_customer_email CHECK (email IS NULL OR email ~* '^[^@]+@[^@]+\.[^@]+$')
);

CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(display_name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- ---------- 6. Rentals (transactional) ----------
-- One row per rental booking. Rental duration = [booked_at, returned_at]
-- with due_date as the contractual return target.
CREATE TABLE IF NOT EXISTS rentals (
    id            BIGSERIAL PRIMARY KEY,
    item_sku      VARCHAR(100) NOT NULL REFERENCES items(item_sku),
    customer_id   UUID         NOT NULL REFERENCES customers(id),

    booked_at     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    due_date      DATE         NOT NULL,
    returned_at   TIMESTAMPTZ,                   -- NULL until returned
    rental_price  DECIMAL(10,2) NOT NULL,        -- snapshot at booking (total for the booking)
    quantity      INT          NOT NULL DEFAULT 1 CHECK (quantity > 0),
    status        VARCHAR(20)  NOT NULL DEFAULT 'Rented'
                    CHECK (status IN ('Rented', 'Returned', 'Cancelled')),

    notes         TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by    VARCHAR(100) NOT NULL DEFAULT CURRENT_USER,

    CONSTRAINT chk_rental_dates CHECK (due_date >= booked_at::date)
    -- returned_at <= CURRENT_TIMESTAMP enforced by trigger if needed
);

CREATE INDEX IF NOT EXISTS idx_rentals_item      ON rentals(item_sku);
CREATE INDEX IF NOT EXISTS idx_rentals_customer  ON rentals(customer_id);
CREATE INDEX IF NOT EXISTS idx_rentals_status    ON rentals(status);
CREATE INDEX IF NOT EXISTS idx_rentals_due       ON rentals(due_date);
CREATE INDEX IF NOT EXISTS idx_rentals_open      ON rentals(item_sku) WHERE status = 'Rented';

-- Enforce a single active rental per physical SKU (one unit each).
CREATE UNIQUE INDEX IF NOT EXISTS uq_rentals_one_active_per_sku
    ON rentals(item_sku) WHERE status = 'Rented';

-- ---------- 7. Derived views ----------

-- Current on-hand stock per item.
CREATE OR REPLACE VIEW v_item_stock AS
SELECT
    i.item_sku,
    i.item_name,
    i.shop_code,
    COALESCE(SUM(s.quantity_change), 0) AS live_stock,
    i.min_stock_alert,
    (COALESCE(SUM(s.quantity_change), 0) <= i.min_stock_alert) AS low_stock
FROM items i
LEFT JOIN stock_movements s ON s.item_sku = i.item_sku
GROUP BY i.item_sku, i.item_name, i.shop_code, i.min_stock_alert;

-- Current bridal lifecycle status (most recent non-rental event),
-- overridden by an active rental if one exists.
CREATE OR REPLACE VIEW v_item_current_status AS
SELECT
    i.item_sku,
    i.shop_code,
    CASE
        WHEN r.id IS NOT NULL THEN 'Rented'
        WHEN l.status IS NOT NULL THEN l.status
        ELSE 'Available'
    END AS current_status,
    r.id        AS active_rental_id,
    r.due_date  AS rental_due_date,
    r.customer_id
FROM items i
LEFT JOIN LATERAL (
    SELECT status FROM item_lifecycle_events le
    WHERE le.item_sku = i.item_sku
    ORDER BY le.occurred_at DESC LIMIT 1
) l ON TRUE
LEFT JOIN LATERAL (
    SELECT id, due_date, customer_id FROM rentals rr
    WHERE rr.item_sku = i.item_sku AND rr.status = 'Rented'
    LIMIT 1
) r ON TRUE
WHERE i.shop_code = 'Bridal';

-- Profit metrics per item.
CREATE OR REPLACE VIEW v_item_profit AS
SELECT
    item_sku,
    item_name,
    sell_price,
    stock_cost_price,
    (sell_price - stock_cost_price) AS gross_profit,
    CASE WHEN sell_price > 0
         THEN ROUND(((sell_price - stock_cost_price) / sell_price) * 100, 2)
         ELSE NULL END AS profit_margin_pct
FROM items;

-- Backward-compatible unified history view (read-only) so existing
-- SELECT queries keep working during migration. INSERTs must be
-- rewritten to target the new tables.
CREATE OR REPLACE VIEW v_unified_inventory_history AS
SELECT
    s.id,
    s.created_at,
    i.shop_code      AS shop_type,
    i.item_sku,
    i.item_name,
    i.brand_designer,
    i.item_image,
    COALESCE(s.unit_cost_price, i.stock_cost_price) AS stock_cost_price,
    i.sell_price,
    (i.sell_price - COALESCE(s.unit_cost_price, i.stock_cost_price)) AS gross_profit,
    s.quantity_change,
    i.min_stock_alert,
    i.bag_color,
    i.bridal_size,
    cs.current_status AS bridal_status,
    cs.rental_due_date,
    NULL::VARCHAR(255) AS customer_name_contact,  -- join customers on demand
    s.action_type,
    s.notes
FROM stock_movements s
JOIN items i ON i.item_sku = s.item_sku
LEFT JOIN v_item_current_status cs ON cs.item_sku = i.item_sku;

-- ---------- 8. Updated_at trigger for items ----------
CREATE OR REPLACE FUNCTION fn_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := CURRENT_TIMESTAMP; RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_items_touch ON items;
CREATE TRIGGER trg_items_touch BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at();

-- ---------- Verification ----------
SELECT 'Normalized schema v2 created successfully' AS status;
