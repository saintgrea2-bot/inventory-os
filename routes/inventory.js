const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════════════════════
// HELPER — wrap async route handlers
// ═══════════════════════════════════════════════════════════════════════════
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/inventory/log
// Validates and appends a new transaction row to unified_inventory_history
// ═══════════════════════════════════════════════════════════════════════════
router.post('/log', asyncHandler(async (req, res) => {
  let {
    shop_type,
    item_sku,
    item_name,
    brand_designer,
    stock_cost_price,
    sell_price,
    quantity_change,
    bag_color,
    min_stock_alert,
    bridal_size,
    bridal_status,
    rental_due_date,
    customer_name_contact,
    action_type,
    notes,
  } = req.body;

  // ── Validation ────────────────────────────────────────────────────────────
  const errors = [];

  if (!shop_type || !['Bags', 'Bridal'].includes(shop_type))
    errors.push('shop_type must be "Bags" or "Bridal".');
  if (!item_sku || String(item_sku).trim() === '')
    errors.push('item_sku is required.');
  if (!item_name || String(item_name).trim() === '')
    errors.push('item_name is required.');
  if (!action_type || !['New Item', 'Restock', 'Retail Sale', 'Rental Out', 'Rental Return', 'Status Change'].includes(action_type))
    errors.push('action_type is invalid.');
  if (bridal_status && !['Available', 'Rented', 'In Alteration', 'Dry Cleaning', 'Sold'].includes(bridal_status))
    errors.push('bridal_status is invalid.');

  if (errors.length > 0)
    return res.status(400).json({ error: 'Validation failed', details: errors });

  // ── Rental Financial Logic ─────────────────────────────────────────────────
  // When renting out, the item cost was already recorded on the New Item row.
  // Set stock_cost_price = 0.00 so that the full rental price = 100% margin.
  if (action_type === 'Rental Out') {
    stock_cost_price = 0.00;
  }

  // ── Type coercion & defaults ───────────────────────────────────────────────
  stock_cost_price   = parseFloat(stock_cost_price)  || 0.00;
  sell_price         = parseFloat(sell_price)         || 0.00;
  quantity_change    = parseInt(quantity_change)       || 0;
  min_stock_alert    = parseInt(min_stock_alert)       || 2;
  item_sku           = String(item_sku).trim().toUpperCase();
  brand_designer     = brand_designer   || null;
  bag_color          = bag_color        || null;
  bridal_size        = bridal_size      || null;
  bridal_status      = bridal_status    || null;
  rental_due_date    = rental_due_date  || null;
  customer_name_contact = customer_name_contact || null;
  notes              = notes            || null;

  // ── Insert ────────────────────────────────────────────────────────────────
  const sql = `
    INSERT INTO unified_inventory_history (
      shop_type, item_sku, item_name, brand_designer,
      stock_cost_price, sell_price,
      quantity_change, min_stock_alert,
      bag_color, bridal_size, bridal_status,
      rental_due_date, customer_name_contact,
      action_type, notes
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6,
      $7, $8,
      $9, $10, $11,
      $12, $13,
      $14, $15
    )
    RETURNING
      id, created_at, item_sku, item_name, action_type,
      gross_profit,
      CASE WHEN sell_price = 0 THEN 0.00
           ELSE ROUND(((sell_price - stock_cost_price) / sell_price) * 100, 2)
      END AS profit_margin;
  `;

  const values = [
    shop_type, item_sku, item_name, brand_designer,
    stock_cost_price, sell_price,
    quantity_change, min_stock_alert,
    bag_color, bridal_size, bridal_status,
    rental_due_date, customer_name_contact,
    action_type, notes,
  ];

  const result = await pool.query(sql, values);
  const row = result.rows[0];

  return res.status(201).json({
    message: `✅ Action "${action_type}" logged for SKU ${item_sku}`,
    transaction: row,
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/inventory/live
// CTE + window function: dynamically assembles real-time stock state
// ═══════════════════════════════════════════════════════════════════════════
router.get('/live', asyncHandler(async (req, res) => {
  const { shop_type } = req.query;

  const shopFilter = shop_type && ['Bags', 'Bridal'].includes(shop_type)
    ? `AND base.shop_type = $1`
    : '';
  const values = shopFilter ? [shop_type] : [];

  const sql = `
    WITH ranked AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY item_sku
          ORDER BY created_at DESC
        ) AS rn
      FROM unified_inventory_history
    ),
    stock_totals AS (
      SELECT
        item_sku,
        SUM(quantity_change) AS live_stock
      FROM unified_inventory_history
      GROUP BY item_sku
    ),
    profit_totals AS (
      SELECT
        item_sku,
        SUM(gross_profit) AS total_gross_profit,
        SUM(sell_price)   AS total_revenue
      FROM unified_inventory_history
      WHERE action_type IN ('Retail Sale', 'Rental Out', 'New Item')
      GROUP BY item_sku
    )
    SELECT
      base.id,
      base.item_sku,
      base.item_name,
      base.brand_designer,
      base.shop_type,
      base.bag_color,
      base.bridal_size,
      base.bridal_status,
      base.rental_due_date,
      base.customer_name_contact,
      base.min_stock_alert,
      base.sell_price,
      base.stock_cost_price,
      base.action_type          AS last_action,
      base.created_at           AS last_updated,
      base.notes,
      COALESCE(st.live_stock, 0) AS live_stock,
      COALESCE(pt.total_gross_profit, 0) AS total_gross_profit,
      COALESCE(pt.total_revenue, 0)      AS total_revenue,
      CASE
        WHEN base.sell_price = 0 THEN 0.00
        ELSE ROUND(
          ((base.sell_price - base.stock_cost_price) / base.sell_price) * 100,
          2
        )
      END AS profit_margin
    FROM ranked base
    LEFT JOIN stock_totals st ON st.item_sku = base.item_sku
    LEFT JOIN profit_totals pt ON pt.item_sku = base.item_sku
    WHERE base.rn = 1
    ${shopFilter}
    ORDER BY base.shop_type, base.item_name ASC;
  `;

  const result = await pool.query(sql, values);

  // ── Aggregate summary stats ───────────────────────────────────────────────
  const rows = result.rows;
  const totalItems    = rows.length;
  const totalStock    = rows.reduce((s, r) => s + parseInt(r.live_stock || 0), 0);
  const totalProfit   = rows.reduce((s, r) => s + parseFloat(r.total_gross_profit || 0), 0);
  const lowStockItems = rows.filter(r => parseInt(r.live_stock) <= parseInt(r.min_stock_alert) && r.shop_type === 'Bags');
  const activeRentals = rows.filter(r => r.bridal_status === 'Rented');
  const overdueRentals = activeRentals.filter(r => {
    if (!r.rental_due_date) return false;
    return new Date(r.rental_due_date) < new Date();
  });

  return res.json({
    summary: {
      totalItems,
      totalStock,
      totalProfit: totalProfit.toFixed(2),
      activeRentals: activeRentals.length,
      overdueRentals: overdueRentals.length,
      lowStockItems: lowStockItems.length,
    },
    items: rows,
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/inventory/history
// Full chronological audit trail, newest row first
// ═══════════════════════════════════════════════════════════════════════════
router.get('/history', asyncHandler(async (req, res) => {
  const { shop_type, item_sku, limit = 500 } = req.query;

  const conditions = [];
  const values = [];

  if (shop_type && ['Bags', 'Bridal'].includes(shop_type)) {
    values.push(shop_type);
    conditions.push(`shop_type = $${values.length}`);
  }
  if (item_sku) {
    values.push(String(item_sku).trim().toUpperCase());
    conditions.push(`item_sku = $${values.length}`);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  values.push(parseInt(limit) || 500);

  const sql = `
    SELECT
      id, created_at, shop_type, item_sku, item_name, brand_designer,
      stock_cost_price, sell_price, gross_profit,
      CASE
        WHEN sell_price = 0 THEN 0.00
        ELSE ROUND(((sell_price - stock_cost_price) / sell_price) * 100, 2)
      END AS profit_margin,
      quantity_change, bag_color, min_stock_alert,
      bridal_size, bridal_status, rental_due_date, customer_name_contact,
      action_type, notes
    FROM unified_inventory_history
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${values.length};
  `;

  const result = await pool.query(sql, values);

  return res.json({
    count: result.rows.length,
    history: result.rows,
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/inventory/item/:sku
// Removes the full transaction history for a given SKU (scoped to shop_type)
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/item/:sku', asyncHandler(async (req, res) => {
  const { sku } = req.params;
  const { shop_type } = req.query;

  if (!sku) return res.status(400).json({ error: 'SKU is required.' });
  if (shop_type && !['Bags', 'Bridal'].includes(shop_type))
    return res.status(400).json({ error: 'shop_type must be "Bags" or "Bridal".' });

  const normalizedSku = String(sku).trim().toUpperCase();
  const where = shop_type
    ? `WHERE item_sku = $1 AND shop_type = $2`
    : `WHERE item_sku = $1`;
  const values = shop_type ? [normalizedSku, shop_type] : [normalizedSku];

  const result = await pool.query(
    `DELETE FROM unified_inventory_history ${where} RETURNING id;`,
    values
  );

  return res.json({
    message: `✅ Deleted ${result.rowCount} transaction(s) for SKU ${normalizedSku}`,
    deleted: result.rowCount,
  });
}));

module.exports = router;
