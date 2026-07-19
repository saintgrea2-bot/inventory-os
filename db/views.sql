-- =============================================================
-- Compatibility views: project normalized v2 tables into the legacy
-- unified_inventory_history row shape so the Express routes can cut
-- over without changing the API JSON contract.
--   psql "$DATABASE_URL" -f db/views.sql
-- =============================================================

-- Allow customer upsert by display_name (the legacy free-text key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_name ON customers (display_name);

-- ---------- v_live_inventory: one row per item, current state ----------
-- Mirrors the GET /live response item shape.
CREATE OR REPLACE VIEW v_live_inventory AS
WITH sm_agg AS (
    SELECT sm.item_sku,
           COUNT(*) FILTER (WHERE sm.action_type IN ('New Item', 'Retail Sale')) AS sales_count
    FROM stock_movements sm GROUP BY sm.item_sku
),
rent_agg AS (
    SELECT r.item_sku, SUM(r.rental_price) AS rental_revenue
    FROM rentals r GROUP BY r.item_sku
)
SELECT
    i.item_sku                                AS id,
    i.item_sku,
    i.item_name,
    i.brand_designer,
    i.item_image,
    i.shop_code                               AS shop_type,
    i.bag_color,
    i.bridal_size,
    cs.current_status                         AS bridal_status,
    cs.rental_due_date,
    cust.display_name                         AS customer_name_contact,
    i.min_stock_alert,
    i.sell_price,
    i.stock_cost_price,
    le.action_type                            AS last_action,
    le.occurred_at                            AS last_updated,
    le.notes,
    COALESCE(st.live_stock, 0)                AS live_stock,
    (i.sell_price - i.stock_cost_price) * COALESCE(sa.sales_count, 0)
        + COALESCE(ra.rental_revenue, 0)      AS total_gross_profit,
    i.sell_price * COALESCE(sa.sales_count, 0)
        + COALESCE(ra.rental_revenue, 0)      AS total_revenue,
    CASE WHEN i.sell_price = 0 THEN 0.00
         ELSE ROUND(((i.sell_price - i.stock_cost_price) / i.sell_price) * 100, 2)
    END                                       AS profit_margin,
    rr.rental_quantity                        AS rental_quantity
FROM items i
LEFT JOIN sm_agg               sa  ON sa.item_sku = i.item_sku
LEFT JOIN rent_agg             ra  ON ra.item_sku = i.item_sku
LEFT JOIN v_item_stock            st  ON st.item_sku = i.item_sku
LEFT JOIN v_item_current_status   cs  ON cs.item_sku = i.item_sku
LEFT JOIN LATERAL (
    SELECT r.customer_id, r.quantity AS rental_quantity
    FROM rentals r
    WHERE r.item_sku = i.item_sku AND r.status = 'Rented'
    ORDER BY r.booked_at DESC LIMIT 1
) rr ON TRUE
LEFT JOIN customers cust ON cust.id = rr.customer_id
LEFT JOIN LATERAL (
    SELECT e.action_type, e.occurred_at, e.notes FROM (
        SELECT sm.action_type, sm.created_at AS occurred_at, sm.notes
        FROM stock_movements sm WHERE sm.item_sku = i.item_sku
        UNION ALL
        SELECT 'Status Change' AS action_type, ev.occurred_at, ev.notes
        FROM item_lifecycle_events ev WHERE ev.item_sku = i.item_sku
        UNION ALL
        SELECT CASE WHEN r.status = 'Rented' THEN 'Rental Out' ELSE 'Rental Return' END,
               r.booked_at, r.notes
        FROM rentals r WHERE r.item_sku = i.item_sku
    ) e
    ORDER BY e.occurred_at DESC LIMIT 1
) le ON TRUE;

-- ---------- v_history: chronological union of all events ----------
-- Mirrors the GET /history row shape. Stable synthetic id via row_number.
CREATE OR REPLACE VIEW v_history AS
SELECT
    row_number() OVER (ORDER BY created_at, src, seq) AS id,
    created_at, shop_type, item_sku, item_name, brand_designer, item_image,
    stock_cost_price, sell_price, gross_profit, profit_margin,
    quantity_change, bag_color, min_stock_alert,
    bridal_size, bridal_status, rental_due_date, customer_name_contact,
    action_type, notes
FROM (
    SELECT
        1 AS src, sm.id AS seq,
        sm.created_at,
        i.shop_code AS shop_type, i.item_sku, i.item_name, i.brand_designer, i.item_image,
        COALESCE(sm.unit_cost_price, i.stock_cost_price) AS stock_cost_price,
        i.sell_price,
        (i.sell_price - COALESCE(sm.unit_cost_price, i.stock_cost_price)) AS gross_profit,
        CASE WHEN i.sell_price = 0 THEN 0.00
             ELSE ROUND(((i.sell_price - COALESCE(sm.unit_cost_price, i.stock_cost_price)) / i.sell_price) * 100, 2)
        END AS profit_margin,
        sm.quantity_change, i.bag_color, i.min_stock_alert, i.bridal_size,
        cs.current_status AS bridal_status, NULL::date AS rental_due_date,
        NULL::varchar AS customer_name_contact,
        sm.action_type, sm.notes
    FROM stock_movements sm
    JOIN items i ON i.item_sku = sm.item_sku
    LEFT JOIN v_item_current_status cs ON cs.item_sku = i.item_sku

    UNION ALL

    SELECT
        2 AS src, ev.id AS seq,
        ev.occurred_at AS created_at,
        i.shop_code, i.item_sku, i.item_name, i.brand_designer, i.item_image,
        i.stock_cost_price, i.sell_price,
        (i.sell_price - i.stock_cost_price) AS gross_profit,
        CASE WHEN i.sell_price = 0 THEN 0.00
             ELSE ROUND(((i.sell_price - i.stock_cost_price) / i.sell_price) * 100, 2)
        END AS profit_margin,
        0 AS quantity_change, i.bag_color, i.min_stock_alert, i.bridal_size,
        ev.status AS bridal_status, NULL::date, NULL::varchar,
        'Status Change' AS action_type, ev.notes
    FROM item_lifecycle_events ev
    JOIN items i ON i.item_sku = ev.item_sku

    UNION ALL

    SELECT
        3 AS src, r.id AS seq,
        r.booked_at AS created_at,
        i.shop_code, i.item_sku, i.item_name, i.brand_designer, i.item_image,
        0.00 AS stock_cost_price, r.rental_price AS sell_price,
        r.rental_price AS gross_profit,
        100.00 AS profit_margin,
        r.quantity AS quantity_change, i.bag_color, i.min_stock_alert, i.bridal_size,
        r.status AS bridal_status, r.due_date AS rental_due_date,
        cust.display_name AS customer_name_contact,
        CASE WHEN r.status = 'Rented' THEN 'Rental Out' ELSE 'Rental Return' END AS action_type,
        r.notes
    FROM rentals r
    JOIN items i ON i.item_sku = r.item_sku
    LEFT JOIN customers cust ON cust.id = r.customer_id
) u;

SELECT 'Compatibility views created successfully' AS status;
