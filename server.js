require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

// ─── Database Pool ──────────────────────────────────────────────────────────
// Railway provides DATABASE_URL; fall back to individual vars for local dev
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // required by Railway / Render
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'inventory_db',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

const pool = new Pool(poolConfig);

// Export pool for use in routes (must be before requiring routes)
module.exports.pool = pool;

// ─── Auto-run Schema on First Boot ─────────────────────────────────────────
async function initSchema() {
  const client = await pool.connect();
  try {
    // Check if table already exists
    const exists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'unified_inventory_history'
      );
    `);

    if (!exists.rows[0].exists) {
      console.log('⏳  Table not found — running schema setup…');
      const schemaPath = path.join(__dirname, 'db', 'schema.sql');
      const sql = fs.readFileSync(schemaPath, 'utf8');

      const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('SELECT'));

      for (const stmt of statements) {
        if (stmt.trim()) await client.query(stmt);
      }
      console.log('✅  Schema created successfully.');
    } else {
      console.log('✅  Database table verified — ready.');
    }
  } catch (err) {
    console.error('❌  Schema init failed:', err.message);
  } finally {
    client.release();
  }
}

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
