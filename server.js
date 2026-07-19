require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// ─── Database Pool ──────────────────────────────────────────────────────────
const pool = require('./db/pool');

// ─── Auto-verify Schema on First Boot ──────────────────────────────────────
async function initSchema() {
  let client;
  try {
    client = await pool.connect();
    // Verify the normalized v2 schema is present (items is the anchor table).
    const exists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'items'
      );
    `);

    if (!exists.rows[0].exists) {
      console.log('⏳  Normalized schema not found — run db/schema_normalized.sql + db/views.sql against the database.');
    } else {
      console.log('✅  Normalized schema verified — ready.');
    }
  } catch (err) {
    console.error('❌  Schema init failed:', err.message);
  } finally {
    if (client) client.release();
  }
}

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ─────────────────────────────────────────────────────────────
const inventoryRoutes = require('./routes/inventory');
app.use('/api/inventory', inventoryRoutes);

// ─── Health check (Railway uses this) ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ─── Catch-all: serve index.html for SPA ───────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global Error Handler ───────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

// ─── Start Server ───────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');

app.listen(PORT, async () => {
  console.log(`\n🚀  InventoryOS running at http://localhost:${PORT}`);
  console.log(`📦  Serving frontend from ./public`);
  console.log(`🔗  API base: http://localhost:${PORT}/api/inventory\n`);
  await initSchema();
});
