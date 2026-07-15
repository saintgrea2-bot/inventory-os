-- =============================================================
-- Inventory Management System — Single-Table Transaction Log
-- Run once against your target database:
--   psql -U postgres -d inventory_db -f db/schema.sql
-- =============================================================

-- Drop and recreate for a clean slate (remove DROP if you want to preserve data)
-- DROP TABLE IF EXISTS unified_inventory_history;

CREATE TABLE IF NOT EXISTS unified_inventory_history (
    id                    SERIAL PRIMARY KEY,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Shop context
    shop_type             VARCHAR(20)  NOT NULL
                            CHECK (shop_type IN ('Bags', 'Bridal')),

    -- Item identity
    item_sku              VARCHAR(100) NOT NULL,
    item_name             VARCHAR(255) NOT NULL,
    brand_designer        VARCHAR(100),

    -- Financials
    stock_cost_price      DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    sell_price            DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    gross_profit          DECIMAL(10, 2) GENERATED ALWAYS AS (sell_price - stock_cost_price) STORED,
    -- profit_margin is calculated dynamically in queries via CASE statement

    -- Stock
    quantity_change       INT DEFAULT 0,
    min_stock_alert       INT DEFAULT 2,

    -- Bags-specific
    bag_color             VARCHAR(50),

    -- Bridal-specific
    bridal_size           VARCHAR(50),
    bridal_status         VARCHAR(50)
                            CHECK (bridal_status IN ('Available', 'Rented', 'In Alteration', 'Dry Cleaning', 'Sold', NULL)),
    rental_due_date       DATE,
    customer_name_contact VARCHAR(255),

    -- Action metadata
    action_type           VARCHAR(50) NOT NULL
                            CHECK (action_type IN ('New Item', 'Restock', 'Retail Sale', 'Rental Out', 'Rental Return', 'Status Change')),
    notes                 TEXT
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_uih_item_sku       ON unified_inventory_history (item_sku);
CREATE INDEX IF NOT EXISTS idx_uih_created_at     ON unified_inventory_history (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uih_shop_type      ON unified_inventory_history (shop_type);
CREATE INDEX IF NOT EXISTS idx_uih_action_type    ON unified_inventory_history (action_type);
CREATE INDEX IF NOT EXISTS idx_uih_bridal_status  ON unified_inventory_history (bridal_status);
CREATE INDEX IF NOT EXISTS idx_uih_sku_created    ON unified_inventory_history (item_sku, created_at DESC);

-- Verification
SELECT 'Schema created successfully' AS status;
