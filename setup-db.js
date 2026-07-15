/**
 * setup-db.js
 * Run this once to create the database table.
 * Usage: node setup-db.js
 *
 * Make sure your .env is configured with correct DB credentials first.
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'inventory_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function setup() {
  console.log('\n🔧  InventoryOS — Database Setup\n');
  console.log(`   Host:     ${process.env.DB_HOST || 'localhost'}`);
  console.log(`   Port:     ${process.env.DB_PORT || '5432'}`);
  console.log(`   Database: ${process.env.DB_NAME || 'inventory_db'}`);
  console.log(`   User:     ${process.env.DB_USER || 'postgres'}\n`);

  const client = await pool.connect();

  try {
    console.log('⏳  Connecting to PostgreSQL…');

    const sql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');

    // Filter out comments and split into individual statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('SELECT'));

    for (const stmt of statements) {
      if (stmt.trim()) {
        await client.query(stmt);
      }
    }

    // Verify table was created
    const check = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'unified_inventory_history'
      ORDER BY ordinal_position;
    `);

    console.log(`✅  Table "unified_inventory_history" created with ${check.rows.length} columns:\n`);
    check.rows.forEach(r => {
      console.log(`   • ${r.column_name.padEnd(30)} ${r.data_type}`);
    });

    console.log('\n🚀  Setup complete! Run "npm start" or "npm run dev" to launch the server.\n');

  } catch (err) {
    console.error('\n❌  Setup failed:', err.message);
    console.error('\nCommon fixes:');
    console.error('  1. Check DB credentials in your .env file');
    console.error('  2. Ensure PostgreSQL is running');
    console.error(`  3. Ensure database "${process.env.DB_NAME || 'inventory_db'}" exists`);
    console.error(`     → Create it: psql -U postgres -c "CREATE DATABASE ${process.env.DB_NAME || 'inventory_db'};"\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
