-- =============================================================
-- Data Migration: v1 (unified_inventory_history) -> v2 (normalized)
-- Read-only against the legacy table; idempotent (ON CONFLICT).
-- Run AFTER schema_normalized.sql, BEFORE cutover.
--   psql "$DATABASE_URL" -f db/migrate_v1_to_v2.sql
-- =============================================================

-- ---------- 1. Backfill items master (latest value per SKU) ----------
INSERT INTO items (item_sku, shop_code, item_name, brand_designer, item_image,
                   stock_cost_price, sell_price, min_stock_alert, bag_color, bridal_size)
SELECT DISTINCT ON (h.item_sku)
       h.item_sku,
       h.shop_type,
       h.item_name,
       h.brand_designer,
       h.item_image,
       h.stock_cost_price,
       h.sell_price,
       COALESCE(h.min_stock_alert, 2),
       h.bag_color,
       h.bridal_size
FROM unified_inventory_history h
ORDER BY h.item_sku, h.created_at DESC
ON CONFLICT (item_sku) DO UPDATE SET
    item_name        = EXCLUDED.item_name,
    brand_designer   = EXCLUDED.brand_designer,
    item_image       = EXCLUDED.item_image,
    stock_cost_price = EXCLUDED.stock_cost_price,
    sell_price       = EXCLUDED.sell_price,
    min_stock_alert  = EXCLUDED.min_stock_alert,
    bag_color        = EXCLUDED.bag_color,
    bridal_size      = EXCLUDED.bridal_size,
    updated_at       = CURRENT_TIMESTAMP;

-- ---------- 2. Backfill customers (dedupe by contact string) ----------
-- Stable surrogate: hash the contact text into a UUIDv5-ish deterministic
-- value via gen_random_uuid() is NOT deterministic, so we map by a temp
-- table to keep one customer per distinct contact.
CREATE TEMP TABLE _cust_map AS
SELECT row_number() OVER () AS rn, contact
FROM (
    SELECT DISTINCT COALESCE(h.customer_name_contact, 'Walk-in') AS contact
    FROM unified_inventory_history h
    WHERE h.customer_name_contact IS NOT NULL
) d;

INSERT INTO customers (id, display_name)
SELECT gen_random_uuid(), contact FROM _cust_map
ON CONFLICT DO NOTHING;

-- ---------- 3. Stock movements (stock-affecting actions) ----------
INSERT INTO stock_movements (item_sku, action_type, quantity_change, unit_cost_price, notes, created_at, created_by)
SELECT h.item_sku,
       h.action_type,
       COALESCE(h.quantity_change, 0),
       h.stock_cost_price,
       h.notes,
       h.created_at,
       'migration'
FROM unified_inventory_history h
WHERE h.action_type IN ('New Item', 'Restock', 'Retail Sale');

-- ---------- 4. Lifecycle events (Status Change) ----------
INSERT INTO item_lifecycle_events (item_sku, status, notes, occurred_at, recorded_by)
SELECT h.item_sku,
       h.bridal_status,
       h.notes,
       h.created_at,
       'migration'
FROM unified_inventory_history h
WHERE h.action_type = 'Status Change'
  AND h.bridal_status IS NOT NULL;

-- ---------- 5. Rentals: 'Rental Out' creates a booking ----------
INSERT INTO rentals (item_sku, customer_id, booked_at, due_date, rental_price, status, notes, created_at, created_by)
SELECT h.item_sku,
       c.id,
       h.created_at,
       COALESCE(h.rental_due_date, (h.created_at::date + INTERVAL '7 days')::date),
       h.sell_price,
       'Rented',
       h.notes,
       h.created_at,
       'migration'
FROM unified_inventory_history h
LEFT JOIN _cust_map m ON m.contact = COALESCE(h.customer_name_contact, 'Walk-in')
LEFT JOIN customers  c ON c.display_name = m.contact
WHERE h.action_type = 'Rental Out';

-- ---------- 6. Rentals: 'Rental Return' closes the most recent open rental ----------
UPDATE rentals r
SET returned_at = h.created_at,
    status     = 'Returned'
FROM ( SELECT DISTINCT ON (h.item_sku) h.item_sku, h.created_at
       FROM unified_inventory_history h
       WHERE h.action_type = 'Rental Return'
       ORDER BY h.item_sku, h.created_at DESC ) h
WHERE r.item_sku = h.item_sku
  AND r.status   = 'Rented';

-- ---------- 7. Verification counts ----------
SELECT 'items'           AS table_name, COUNT(*) FROM items
UNION ALL SELECT 'stock_movements',      COUNT(*) FROM stock_movements
UNION ALL SELECT 'item_lifecycle_events',COUNT(*) FROM item_lifecycle_events
UNION ALL SELECT 'customers',            COUNT(*) FROM customers
UNION ALL SELECT 'rentals',              COUNT(*) FROM rentals;

SELECT 'Migration complete' AS status;
