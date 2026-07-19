const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// ═══════════════════════════════════════════════════════════════════════════
// HELPER — wrap async route handlers
// ═══════════════════════════════════════════════════════════════════════════
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const VALID_SHOPS = ['Bags', 'Bridal'];
const VALID_ACTIONS = ['New Item', 'Restock', 'Retail Sale', 'Rental Out', 'Rental Return', 'Status Change'];
const VALID_LIFECYCLE = ['Available', 'In Alteration', 'Dry Cleaning', 'Sold'];

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/inventory/log
// Writes to the normalized v2 schema (items / stock_movements /
// item_lifecycle_events / customers / rentals) inside a single tx.
// Response shape is preserved for the frontend.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/log', asyncHandler(async (req, res) => {
  let {
    shop_type, item_sku, item_name, brand_designer, item_image,
    stock_cost_price, sell_price, quantity_change, quantity, bag_color, min_stock_alert,
    bridal_size, bridal_status, rental_due_date, customer_name_contact,
    action_type, notes,
  } = req.body;

  // ── Validation ────────────────────────────────────────────────────────────
  const errors = [];
  if (!shop_type || !VALID_SHOPS.includes(shop_type)) errors.push('shop_type must be "Bags" or "Bridal".');
  if (!item_sku || String(item_sku).trim() === '') errors.push('item_sku is required.');
  if (!item_name || String(item_name).trim() === '') errors.push('item_name is required.');
  if (!action_type || !VALID_ACTIONS.includes(action_type)) errors.push('action_type is invalid.');
  if (bridal_status && !['Available', 'Rented', 'Returned', 'In Alteration', 'Dry Cleaning', 'Sold'].includes(bridal_status))
    errors.push('bridal_status is invalid.');
  if (errors.length > 0) return res.status(400).json({ error: 'Validation failed', details: errors });

  // ── Rental Financial Logic ─────────────────────────────────────────────────
  if (action_type === 'Rental Out') stock_cost_price = 0.00;

  // ── Type coercion & defaults ───────────────────────────────────────────────
  stock_cost_price       = parseFloat(stock_cost_price)  || 0.00;
  sell_price             = parseFloat(sell_price)        || 0.00;
  quantity_change        = parseInt(quantity_change)     || 0;
  min_stock_alert        = parseInt(min_stock_alert)     || 2;
  item_sku               = String(item_sku).trim().toUpperCase();
  brand_designer         = brand_designer   || null;
  item_image             = item_image       || null;
  bag_color              = bag_color        || null;
  bridal_size            = bridal_size      || null;
  bridal_status          = bridal_status    || null;
  rental_due_date        = rental_due_date  || null;
  customer_name_contact  = customer_name_contact || null;
  notes                  = notes            || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Upsert item master.
    await client.query(`
      INSERT INTO items (item_sku, shop_code, item_name, brand_designer, item_image,
                         stock_cost_price, sell_price, min_stock_alert, bag_color, bridal_size)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (item_sku) DO UPDATE SET
        item_name        = COALESCE(EXCLUDED.item_name, items.item_name),
        brand_designer   = COALESCE(EXCLUDED.brand_designer, items.brand_designer),
        item_image       = COALESCE(EXCLUDED.item_image, items.item_image),
        stock_cost_price = COALESCE(EXCLUDED.stock_cost_price, items.stock_cost_price),
        sell_price       = COALESCE(EXCLUDED.sell_price, items.sell_price),
        min_stock_alert  = COALESCE(EXCLUDED.min_stock_alert, items.min_stock_alert),
        bag_color        = COALESCE(EXCLUDED.bag_color, items.bag_color),
        bridal_size      = COALESCE(EXCLUDED.bridal_size, items.bridal_size),
        updated_at       = CURRENT_TIMESTAMP
    `, [item_sku, shop_type, item_name, brand_designer, item_image,
        stock_cost_price, sell_price, min_stock_alert, bag_color, bridal_size]);

    let transaction;

    if (action_type === 'Rental Out') {
      const contactName = customer_name_contact || 'Walk-in';
      const cu = await client.query(
        `INSERT INTO customers (display_name) VALUES ($1)
         ON CONFLICT (display_name) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id;`, [contactName]);
      const customerId = cu.rows[0].id;

      const rentalQty = parseInt(quantity) > 0 ? parseInt(quantity) : 1;
      const r = await client.query(`
        INSERT INTO rentals (item_sku, customer_id, due_date, rental_price, quantity, status, notes)
        VALUES ($1,$2,$3,$4,$5,'Rented',$6)
        RETURNING id, booked_at AS created_at, quantity;`,
        [item_sku, customerId, rental_due_date, sell_price, rentalQty, notes]);
      transaction = { id: r.rows[0].id, created_at: r.rows[0].created_at, item_sku, item_name, action_type, quantity: r.rows[0].quantity, gross_profit: sell_price, profit_margin: 100.00 };
    }
    else if (action_type === 'Rental Return') {
      const r = await client.query(`
        UPDATE rentals SET returned_at = CURRENT_TIMESTAMP, status = 'Returned'
        WHERE id = (SELECT id FROM rentals WHERE item_sku = $1 AND status = 'Rented'
                    ORDER BY booked_at DESC LIMIT 1)
        RETURNING id, booked_at AS created_at;`, [item_sku]);
      if (bridal_status && VALID_LIFECYCLE.includes(bridal_status)) {
        await client.query(`INSERT INTO item_lifecycle_events (item_sku, status, notes) VALUES ($1,$2,$3);`, [item_sku, bridal_status, notes]);
      }
      transaction = { id: r.rows[0]?.id || null, created_at: r.rows[0]?.created_at || new Date(), item_sku, item_name, action_type, gross_profit: 0, profit_margin: 0 };
    }
    else if (action_type === 'Status Change') {
      const e = await client.query(
        `INSERT INTO item_lifecycle_events (item_sku, status, notes) VALUES ($1,$2,$3) RETURNING id, occurred_at AS created_at;`,
        [item_sku, bridal_status || 'Available', notes]);
      transaction = { id: e.rows[0].id, created_at: e.rows[0].created_at, item_sku, item_name, action_type, gross_profit: 0, profit_margin: 0 };
    }
    else {
      // New Item / Restock / Retail Sale → stock ledger
      const sm = await client.query(`
        INSERT INTO stock_movements (item_sku, action_type, quantity_change, unit_cost_price, notes)
        VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at;`,
        [item_sku, action_type, quantity_change, stock_cost_price, notes]);
      const gp = sell_price - stock_cost_price;
      const pm = sell_price === 0 ? 0 : Math.round((gp / sell_price) * 10000) / 100;
      transaction = { id: sm.rows[0].id, created_at: sm.rows[0].created_at, item_sku, item_name, action_type, gross_profit: gp, profit_margin: pm };
    }

    await client.query('COMMIT');
    return res.status(201).json({ message: `✅ Action "${action_type}" logged for SKU ${item_sku}`, transaction });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/inventory/live
// Reads current state from the v_live_inventory compat view.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/live', asyncHandler(async (req, res) => {
  const { shop_type } = req.query;
  const shopFilter = shop_type && VALID_SHOPS.includes(shop_type) ? `WHERE shop_type = $1` : '';
  const values = shopFilter ? [shop_type] : [];

  const result = await pool.query(
    `SELECT * FROM v_live_inventory ${shopFilter} ORDER BY shop_type, item_name ASC;`,
    values
  );

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
// Chronological audit trail from the v_history compat view, newest first.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/history', asyncHandler(async (req, res) => {
  const { shop_type, item_sku, limit = 500 } = req.query;

  const conditions = [];
  const values = [];

  if (shop_type && VALID_SHOPS.includes(shop_type)) {
    values.push(shop_type);
    conditions.push(`shop_type = $${values.length}`);
  }
  if (item_sku) {
    values.push(String(item_sku).trim().toUpperCase());
    conditions.push(`item_sku = $${values.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(parseInt(limit) || 500);

  const result = await pool.query(
    `SELECT * FROM v_history ${whereClause} ORDER BY created_at DESC LIMIT $${values.length};`,
    values
  );

  return res.json({ count: result.rows.length, history: result.rows });
}));

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/inventory/item/:sku
// Removes an item and all its history (children first, then the item row).
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/item/:sku', asyncHandler(async (req, res) => {
  const { sku } = req.params;
  const { shop_type } = req.query;

  if (!sku) return res.status(400).json({ error: 'SKU is required.' });
  if (shop_type && !VALID_SHOPS.includes(shop_type))
    return res.status(400).json({ error: 'shop_type must be "Bags" or "Bridal".' });

  const normalizedSku = String(sku).trim().toUpperCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const scope = shop_type ? `AND shop_code = $2` : '';
    const scopeVals = shop_type ? [normalizedSku, shop_type] : [normalizedSku];

    const owned = await client.query(`SELECT 1 FROM items WHERE item_sku = $1 ${scope} LIMIT 1;`, scopeVals);
    if (!owned.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ message: `✅ Deleted 0 transaction(s) for SKU ${normalizedSku}`, deleted: 0 });
    }

    const r1 = await client.query('DELETE FROM rentals               WHERE item_sku = $1;', [normalizedSku]);
    const r2 = await client.query('DELETE FROM stock_movements       WHERE item_sku = $1;', [normalizedSku]);
    const r3 = await client.query('DELETE FROM item_lifecycle_events WHERE item_sku = $1;', [normalizedSku]);
    const r4 = await client.query('DELETE FROM items                 WHERE item_sku = $1;', [normalizedSku]);

    const total = (r1.rowCount || 0) + (r2.rowCount || 0) + (r3.rowCount || 0) + (r4.rowCount || 0);
    await client.query('COMMIT');

    return res.json({ message: `✅ Deleted ${total} transaction(s) for SKU ${normalizedSku}`, deleted: total });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
