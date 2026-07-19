-- =============================================================
-- Data Migration: v1 (unified_inventory_history) -> v2 (normalized)
-- Read-only against the legacy table; re-runnable (rows tagged
-- created_by='migration' are deleted first). Run AFTER
-- schema_normalized.sql, BEFORE cutover.
--   psql "$DATABASE_URL" -f db/migrate_v1_to_v2.sql
-- =============================================================

-- ---------- 0. Clean up any prior partial migration run ----------
DELETE FROM rentals                WHERE created_by  = 'migration';
DELETE FROM customers              WHERE created_by  = 'migration';
DELETE FROM stock_movements        WHERE created_by  = 'migration';
DELETE FROM item_lifecycle_events  WHERE recorded_by = 'migration';
-- items is idempotent via ON CONFLICT (item_sku) DO UPDATE; left alone.

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

-- ---------- 5. Rentals: one row per SKU = its most recent booking ----------
-- The legacy log may contain repeated Rental Out/Return pairs per SKU.
-- We reconstruct the *latest* booking per SKU (matching the legacy app's
-- "latest row per SKU" semantics) so the uq_rentals_one_active_per_sku
-- constraint holds. Full multi-booking history is not recoverable from
-- the log without event correlation.
WITH latest_out AS (
    SELECT DISTINCT ON (h.item_sku)
           h.item_sku,
           h.created_at AS booked_at,
           COALESCE(h.rental_due_date, (h.created_at::date + INTERVAL '7 days')::date) AS due_date,
           h.sell_price,
           h.notes,
           h.customer_name_contact
    FROM unified_inventory_history h
    WHERE h.action_type = 'Rental Out'
    ORDER BY h.item_sku, h.created_at DESC
),
later_return AS (
    SELECT lo.item_sku, MIN(r.created_at) AS returned_at
    FROM latest_out lo
    JOIN unified_inventory_history r
      ON r.item_sku    = lo.item_sku
     AND r.action_type = 'Rental Return'
     AND r.created_at  > lo.booked_at
    GROUP BY lo.item_sku
)
INSERT INTO rentals (item_sku, customer_id, booked_at, due_date, rental_price,
                     status, returned_at, notes, created_at, created_by)
SELECT lo.item_sku,
       c.id,
       lo.booked_at,
       lo.due_date,
       lo.sell_price,
       CASE WHEN lr.returned_at IS NOT NULL THEN 'Returned' ELSE 'Rented' END,
       lr.returned_at,
       lo.notes,
       lo.booked_at,
       'migration'
FROM latest_out lo
LEFT JOIN later_return lr ON lr.item_sku = lo.item_sku
LEFT JOIN _cust_map   m   ON m.contact   = COALESCE(lo.customer_name_contact, 'Walk-in')
LEFT JOIN customers   c   ON c.display_name = m.contact;

-- ---------- 7. Verification counts ----------
SELECT 'items'           AS table_name, COUNT(*) FROM items
UNION ALL SELECT 'stock_movements',      COUNT(*) FROM stock_movements
UNION ALL SELECT 'item_lifecycle_events',COUNT(*) FROM item_lifecycle_events
UNION ALL SELECT 'customers',            COUNT(*) FROM customers
UNION ALL SELECT 'rentals',              COUNT(*) FROM rentals;

SELECT 'Migration complete' AS status;
