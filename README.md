# InventoryOS — Dual-Shop Inventory Management

> Full-stack inventory system for **Ladies Bags** and **Bridal Shop**  
> Built with Node.js + Express + PostgreSQL (single-table append-only log)

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your PostgreSQL credentials
```

### 3. Create the database table
```bash
# Option A — psql CLI
psql -U postgres -d your_database_name -f db/schema.sql

# Option B — connect to your DB and paste the contents of db/schema.sql
```

### 4. Start the server
```bash
# Production
npm start

# Development (auto-restart on changes)
npm run dev
```

### 5. Open in browser
Navigate to: **http://localhost:3000**

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (HTML + Vanilla JS + CSS)                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐ │
│  │ Action Form│  │ Live Table │  │ Audit Trail    │ │
│  └─────┬──────┘  └─────┬──────┘  └───────┬────────┘ │
└────────┼───────────────┼─────────────────┼──────────┘
         │ POST /log     │ GET /live        │ GET /history
┌────────▼───────────────▼─────────────────▼──────────┐
│  Express API (Node.js)                               │
│  routes/inventory.js                                │
└──────────────────────┬──────────────────────────────┘
                       │ pg Pool
┌──────────────────────▼──────────────────────────────┐
│  PostgreSQL — unified_inventory_history              │
│  Single append-only transaction log table            │
│  Live state computed via CTE + ROW_NUMBER()          │
└─────────────────────────────────────────────────────┘
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/inventory/log` | Append a new inventory transaction |
| `GET`  | `/api/inventory/live` | Live stock state (CTE window function) |
| `GET`  | `/api/inventory/history` | Full audit trail, newest first |

### POST `/api/inventory/log` — Body Parameters
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `shop_type` | string | ✅ | `Bags` or `Bridal` |
| `item_sku` | string | ✅ | Auto-uppercased |
| `item_name` | string | ✅ | |
| `action_type` | string | ✅ | See valid values below |
| `sell_price` | decimal | — | |
| `stock_cost_price` | decimal | — | Auto-zeroed for `Rental Out` |
| `quantity_change` | int | — | Negative for outgoing stock |
| `bridal_status` | string | — | `Available`, `Rented`, etc. |
| `rental_due_date` | date | — | `YYYY-MM-DD` |

**Valid `action_type` values:**
`New Item` · `Restock` · `Retail Sale` · `Rental Out` · `Rental Return` · `Status Change`

---

## Financial Logic

| Action | `stock_cost_price` | Effect |
|--------|-------------------|--------|
| `New Item` | Actual cost paid | Records capital outlay |
| `Restock` | Actual cost paid | Adds to cost basis |
| `Retail Sale` | Cost at time of sale | Gross profit = sell − cost |
| **`Rental Out`** | **Auto-set to `0.00`** | **100% profit margin on rental revenue** |
| `Rental Return` | `0.00` | No financial impact |
| `Status Change` | `0.00` | No financial impact |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `inventory_db` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | *(empty)* | Database password |
| `PORT` | `3000` | HTTP server port |
