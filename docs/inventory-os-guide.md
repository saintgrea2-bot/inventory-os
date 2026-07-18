# InventoryOS — Application & Technical Guide

> Dual-shop inventory & rental management system for a **Ladies Bag Shop** (bags, accessories, cosmetics) and a **Bridal Shop** (gowns, bridal accessories, rentals).
>
> This document covers (A) the application and its technical architecture, and (B) a comprehensive guide for managing inventory discrepancies (surplus stock) in the rental business.

---

# PART A — The Application

## A.1 Overview

InventoryOS is a full-stack web application that tracks two business units through a single **append-only transaction log**. Live stock state is computed dynamically from the history of transactions — there is no mutable "current stock" column, which preserves a complete audit trail for every item.

| Business unit | Sells | Rents | Module |
|---|---|---|---|
| Ladies Bag Shop | Bags, accessories, cosmetics | No | Bags |
| Bridal Shop | Bridal items, accessories | Yes (gowns + accessories) | Bridal |

## A.2 Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 (Express 4) |
| Database | PostgreSQL (Neon, serverless) |
| DB driver | `pg` (connection pool) |
| Frontend | Vanilla HTML/CSS/JS (no framework) |
| Icons | Remix Icon (CDN) |
| Fonts | Inter (Google Fonts) |
| Excel I/O | SheetJS / `xlsx` (CDN) |
| Hosting | Vercel (Fluid Compute, Express zero-config) |
| Database hosting | Neon (pooled connection, `sslmode=require`) |

## A.3 Architecture

```
Browser (HTML + Vanilla JS + CSS)
  ├── Dashboard view (cross-shop stats + upcoming returns)
  ├── Bags Shop view (inventory + sales + restock)
  └── Bridal Shop view
        ├── Inventory & Sales sub-tab
        └── Rentals sub-tab (rental board + returns)
        ↕ dynamic Action Modal (New Item / Restock / Sale / Rental / Return / Status)
Express API (routes/inventory.js)
  POST /api/inventory/log        append a transaction
  GET  /api/inventory/live       live state (CTE + ROW_NUMBER)
  GET  /api/inventory/history    full audit trail
  DELETE /api/inventory/item/:sku  remove a SKU's history
PostgreSQL — unified_inventory_history (single append-only table)
  Live state computed via CTE + ROW_NUMBER() OVER (PARTITION BY item_sku)
```

### Why append-only
Every action (new item, restock, sale, rental out, return, status change) is a new row. `live_stock` is the running sum of `quantity_change` per SKU; the latest row per SKU carries the current metadata (status, price, etc.). This makes the history tamper-evident and fully auditable — corrections are new rows annotated in `notes`, never in-place edits.

## A.4 Database Schema

Table: `unified_inventory_history`

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `created_at` | TIMESTAMP | default `CURRENT_TIMESTAMP` |
| `shop_type` | VARCHAR(20) | `Bags` \| `Bridal` (CHECK) |
| `item_sku` | VARCHAR(100) | auto-uppercased |
| `item_name` | VARCHAR(255) | |
| `brand_designer` | VARCHAR(100) | |
| `stock_cost_price` | DECIMAL(10,2) | capital outlay |
| `sell_price` | DECIMAL(10,2) | retail/rental price |
| `gross_profit` | DECIMAL(10,2) | **generated**: `sell_price - stock_cost_price` |
| `quantity_change` | INT | negative for outgoing |
| `min_stock_alert` | INT | default 2 |
| `bag_color` | VARCHAR(50) | Bags-specific |
| `bridal_size` | VARCHAR(50) | Bridal-specific |
| `bridal_status` | VARCHAR(50) | `Available`/`Rented`/`Returned`/`In Alteration`/`Dry Cleaning`/`Sold` (CHECK) |
| `rental_due_date` | DATE | |
| `customer_name_contact` | VARCHAR(255) | |
| `action_type` | VARCHAR(50) | `New Item`/`Restock`/`Retail Sale`/`Rental Out`/`Rental Return`/`Status Change` (CHECK) |
| `notes` | TEXT | free-form + correction annotations |

**Indexes:** `item_sku`, `created_at DESC`, `shop_type`, `action_type`, `bridal_status`, `(item_sku, created_at DESC)`.

> The `bridal_status` CHECK intentionally **omits `NULL` from the IN list**. Including `NULL` defeats the constraint (the expression evaluates to NULL, not FALSE, for non-matching values, so the check passes). NULLs are still allowed because `NULL IN (...)` is NULL, which satisfies CHECK.

## A.5 API Reference

Base URL: `/api/inventory`

### POST `/log` — append a transaction
Required: `shop_type`, `item_sku`, `item_name`, `action_type`.
Financial rule: for `Rental Out`, `stock_cost_price` is forced to `0.00` (the item cost was recorded on the `New Item` row; rental revenue is 100% margin).
Returns: the new row with `gross_profit` and `profit_margin`.

### GET `/live` — live inventory state
Uses a CTE with `ROW_NUMBER() OVER (PARTITION BY item_sku ORDER BY created_at DESC)` to pick the latest metadata per SKU, plus `SUM(quantity_change)` for live stock and profit totals. Supports `?shop_type=Bags|Bridal`. Returns a `summary` (totals, active/overdue rentals, low-stock count) and `items[]`.

### GET `/history` — audit trail
Full chronological log, newest first. Filters: `?shop_type=`, `?item_sku=`, `?limit=` (default 500).

### DELETE `/item/:sku` — remove a SKU's history
`?shop_type=` scopes the deletion. Removes all transaction rows for that SKU. **Use only for duplicate/error rows with manager approval** — it breaks audit integrity for legitimate history.

## A.6 Frontend Modules

### Dashboard
Cross-shop stats (items, stock, gross profit, active rentals) + per-shop summary cards + an **upcoming rental returns board** sorted by due date with overdue highlights.

### Bags Shop
- Stats: items, stock, gross profit, low-stock count.
- Actions: **New Item**, **Restock**, **Record Sale** (each via a modal; Restock and Sale use a **product dropdown** of existing items).
- Inventory table with per-row **Update** and **Delete** icons.
- Import/Export (CSV + Excel).

### Bridal Shop — two sub-tabs
**Inventory & Sales:** New Item, Record Sale (product dropdown), Status Change, inventory table, import/export.
**Rentals (dedicated module, separate from sales):**
- **New Rental:** dropdown of *available* items (gowns + accessories) → customer + due date → logs `Rental Out`, status → `Rented`.
- **Status tracking:** Available / Rented / Returned (+ In Alteration / Dry Cleaning / Sold).
- **Status filter:** Rented (active) / Available / Returned / Overdue / All.
- **Returns board:** sorted by due date, "X days left" / "X days overdue" badges, **Process Return** button per rented item (logs `Rental Return`, status → `Returned`).

### Action Modal (dynamic)
A single modal renders the correct form per action type. Product dropdowns are populated from live inventory, so users **select existing products** rather than retyping SKUs — eliminating a major source of data-entry error.

## A.7 Financial Logic

| Action | `stock_cost_price` | Effect |
|---|---|---|
| New Item | actual cost | records capital outlay (gross_profit = −cost) |
| Restock | actual cost | adds to cost basis |
| Retail Sale | cost at sale time | gross profit = sell − cost |
| **Rental Out** | **0.00 (auto)** | **100% margin on rental revenue** |
| Rental Return | 0.00 | no financial impact |
| Status Change | 0.00 | no financial impact |

## A.8 Environment & Deployment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon pooled connection string (production) |
| `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` | individual vars (local dev fallback) |
| `PORT` | HTTP port (default 3000; Vercel sets automatically) |

**Local:** `npm install` → set `.env` → `npm run setup` (creates schema) → `npm start` (or `npm run dev`).
**Production:** Vercel auto-detects Express; `public/` is served via CDN; `DATABASE_URL` is a Vercel env var; schema auto-creates on first boot (`initSchema()`).

## A.9 Known Design Notes
- The DB pool lives in `db/pool.js` (shared by `server.js`, `routes/inventory.js`, `setup-db.js`) to avoid a circular dependency and to support both `DATABASE_URL` and individual vars.
- `initSchema()` fails gracefully — the server stays up even if the DB is unreachable (frontend loads, API returns errors, connection status shows offline).
- Static assets (logos) live in `public/img/` and are served by Vercel's CDN; `express.static()` is ignored on Vercel.

---

# PART B — Managing Inventory Discrepancies (Surplus Stock)

> Scenario: **physical stock count exceeds recorded inventory**. This is the highest-risk discrepancy in a rental business because the most common cause — an unrecorded return — leaves the system believing an item is still out with a customer when it is physically back on the rack.

## B.1 Implementation Plan (Rollout)

Roll out in four phases over ~6 weeks.

### Phase 1 — Preparation (Week 1)
**Owner:** Store Manager + System Admin
- Define severity thresholds: **minor** (±1 unit, single SKU), **moderate** (2–5 units or any rental item), **severe** (>5 units, high-value gown, or recurring on the same SKU).
- Assign roles: **Counter** (physical count), **Reconciler** (investigates + adjusts), **Approver** (authorizes system updates — manager only).
- Configure the system: confirm Audit Trail access for reconcilers; verify the rental status filter; tag high-value rental SKUs in `notes`.
- Create a **Discrepancy Log** (spreadsheet) recording every incident: date, SKU, recorded qty, physical qty, delta, suspected cause, resolution, approver.
- **Exit:** thresholds documented, roles assigned, log template approved.

### Phase 2 — Pilot (Weeks 2–3)
**Owner:** senior Reconciler, Bridal module
- Run the full audit (B.2) on 3–5 seeded surplus incidents (rentals are highest-risk).
- Validate the SOP (B.3) produces correct, reversible adjustments without corrupting live stock.
- **Exit:** 3+ discrepancies reconciled end-to-end; SOP refined.

### Phase 3 — Full Deployment (Weeks 4–5)
**Owner:** all shop staff
- Train both teams: Session 1 — immediate reconciliation + audit; Session 2 — SOP + preventive habits.
- Enforce: **no system adjustment without Approver sign-off** and a Discrepancy Log entry.
- Begin weekly cycle counts of the top 20% high-value rental SKUs.
- **Exit:** 100% trained; cycle-count cadence running; every adjustment traceable in the Audit Trail.

### Phase 4 — Review (Week 6+)
**Owner:** Store Manager
- Monthly review of the Discrepancy Log: trend by SKU, staff, cause category.
- Tune thresholds and cycle-count frequency.
- **Success metrics:** discrepancies per 100 items/month trending down; mean time to root cause < 1 business day; zero unapproved adjustments.

## B.2 Best Practices for Immediate Reconciliation

The immediate goal is to **freeze the error**, not fix the root cause.

1. **Freeze the SKU.** Suspend new Rental Out / Retail Sale on the SKU. Set `bridal_status = In Alteration` (non-rentable holding state) or add `notes: HOLD-RECONCILE`.
2. **Re-count to confirm.** A second person independently recounts. Surplus counts are often counting errors (double-counted gown, accessories in two locations). **Do not act on a single count.**
3. **Snapshot the state.** Record recorded qty, physical qty, delta, last 5 Audit Trail entries, current `bridal_status`, open rental records (customer + due date).
4. **Classify severity** per Phase 1 thresholds.
5. **Do not immediately "correct" the number.** Resist logging a blind `Restock` to match the physical count — it hides the root cause and misleads the Audit Trail. The only immediate system action is the hold.
6. **Communicate.** Notify the manager and staff who transacted the SKU in the last 7 days; their recall is the fastest root-cause signal.

## B.3 Step-by-Step Auditing Process (Root Cause)

Run in order; stop when a cause is confirmed and log it.

**Step 1 — Verify the recorded baseline.**
Open the Audit Trail filtered to the SKU. Sum `quantity_change` across all rows and confirm it matches the displayed `live_stock`. If they differ, it's a **system/query bug** — escalate to the system admin and stop.

**Step 2 — Check for unrecorded returns (most common).**
- Filter Audit Trail for `action_type = Rental Out` on the SKU; confirm each has a matching `Rental Return`.
- Cross-reference the rental board: any item showing `bridal_status = Rented` that is physically present and whose customer says they returned it = **unrecorded return**.
- *Confirm:* contact the customer; check physical condition (cleaning tag, hanger).

**Step 3 — Check for data-entry errors.**
- `Rental Out`/`Retail Sale` with implausible `quantity_change` (e.g., −3 for one rental).
- `Rental Return` with `quantity_change = 0` instead of +1.
- Duplicate rows (same SKU, action, timestamp ±seconds — double-submit).
- `New Item`/`Restock` entered against the **wrong SKU** (inflates one record, deflates another).
- *Confirm:* compare against paper receipt / rental agreement / POS record.

**Step 4 — Check for lost / skipped transactions.**
- Compare against the last known-good count. Transactions in the gap that never reached the system = **lost transactions** (secondary POS, manual handover).
- Check for direct database edits outside the app (rare, early setup).

**Step 5 — Check for cross-shop / location mixing.**
- An accessory rented from Bridal may have been returned to the Bags rack and counted there. Because `shop_type` is per-row, the unit is physically present but recorded under the other shop. Search the Audit Trail for the SKU across **both** shops.
- Check off-site locations: dry cleaner (`Dry Cleaning`), alteration, customer's home for trial.

**Step 6 — Check timing / status desync.**
- Item marked `Returned` but whose `Rental Return` row had `quantity_change = 0` → correct status, wrong stock.
- `Rental Return` (+1) logged but status still `Rented` → status desync; physically present, system says rented.

**Step 7 — Assign cause and document.**

| Category | Example |
|---|---|
| Unrecorded return | Customer returned, staff never logged `Rental Return` |
| Data-entry error | Wrong qty, wrong SKU, duplicate submit |
| Lost transaction | Sale/rental logged elsewhere, never entered |
| Cross-shop mixing | Returned to wrong shop's rack |
| Status desync | Status and qty out of sync |
| Counting error | Physical count was wrong (resolved at B.2.2) |
| Unknown | Escalate |

Record in the Discrepancy Log: SKU, delta, category, evidence (audit-trail row IDs), suspected staff, customer.

## B.4 SOP — Updating the System

All updates go through the **append-only log** via the app's action modal. Never edit historical rows in-place. Every corrective action must be **reversible in the Audit Trail** and **signed off by the Approver**.

**SOP-A — Unrecorded return:**
1. Log `Rental Return`: customer, `bridal_status = Returned` (or `Available` if it goes straight to the floor), `quantity_change = +1`.
2. Verify `live_stock` and `bridal_status` match reality.
3. Remove the hold flag from `notes`.

**SOP-B — Data-entry error (wrong qty / duplicate):**
1. Identify the erroneous row.
2. **Preferred:** log a correcting `Restock` (if qty was over-stated as sold) or a negative-qty adjustment so the running total is correct; annotate `notes: CORRECTION of row #X — original error: …`. The error row stays visible for audit integrity.
3. **Duplicates only, with manager approval:** use the row `DELETE` action to remove the exact duplicate, then re-verify `live_stock`.
4. Document before/after totals in the Discrepancy Log.

**SOP-C — Lost transaction:**
1. Back-fill the missing transaction with the correct `action_type` and `notes: BACKFILL — occurred on YYYY-MM-DD, source: …`. Use realistic `quantity_change` and prices from the external receipt.

**SOP-D — Cross-shop mixing:**
1. Decide the canonical shop for the SKU.
2. Log a `Restock`/`Status Change` in the correct shop and a corresponding negative adjustment in the wrong shop so both totals are correct. Cross-reference both in `notes`.

**SOP-E — Status desync:**
1. Log a `Status Change` to set the correct `bridal_status`. If qty is also wrong, apply SOP-B.

**General rules:**
- Every corrective entry carries a `notes` annotation + Discrepancy Log ID.
- The Approver reviews the resulting Audit Trail before the hold is lifted.
- After correction, **re-count** to confirm physical = recorded; close the incident.

## B.5 Preventive Measures

**Process controls:**
- **Two-step return check-in:** physical inspection + immediate `Rental Return` logging *before* the gown leaves the counter. No "I'll log it later."
- **Mandatory customer confirmation on return** — creates a paper trigger that forces the system entry.
- **Single source of truth:** no secondary POS or manual ledger. Temporary records back-filled same day (SOP-C).
- **SKU discipline:** one SKU = one physical item type; never reuse a SKU across distinct gowns.

**System controls:**
- **Cycle counts:** weekly for top 20% high-value rental SKUs (Class A), monthly full count. Use CSV/Excel **Export** for count sheets.
- **Daily rental-board review:** manager reviews `Rented` + overdue filters each morning — overdue-without-return is the leading indicator of unrecorded returns.
- **Status hygiene:** keep `bridal_status` current; the dashboard's upcoming-returns board surfaces overdue items.
- **Duplicate-submit guard:** wait for the success toast before navigating away (the modal prevents the old stuck-button double-submit).

**People controls:**
- **Training:** every new hire completes the rental check-in/check-out SOP before handling gowns unsupervised.
- **Accountability:** the Audit Trail is per-action with timestamps; review incidents by staff monthly (coaching, not blame).
- **Sign-off:** no inventory adjustment without manager approval, enforced by SOP and audited via `notes: CORRECTION` annotations.

**Technical controls (system admin):**
- Add **API soft-validation**: reject `Rental Out` when `live_stock ≤ 0`; warn on `Rental Return` when no open `Rental Out` exists for the SKU (prevents orphan returns that inflate stock).
- Add a **reconciliation report** endpoint flagging any SKU where `bridal_status = Rented` but the last action was `Rental Return` (or vice versa) — a status/qty desync detector.
- Periodically **export the Audit Trail** to CSV/Excel and archive off-system as an immutable record.

---

*Document version 1.0 — generated for the InventoryOS deployment on Neon + Vercel.*
