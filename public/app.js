/* =====================================================================
   InventoryOS — Frontend Application Logic (Redesigned)
   Dual-Shop: Ladies Bag Shop + Bridal Shop
   ===================================================================== */

'use strict';

const state = {
  currentView: 'dashboard',
  bridalTab: 'sales',
  reconcileShop: 'Bags',
  reconcileCounts: {},
  liveData: [],
  historyData: [],
};

const API = '/api/inventory';
const VALID_STATUSES = ['Available', 'Rented', 'Returned', 'In Alteration', 'Dry Cleaning', 'Sold'];

// ══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════

function fmt(num, decimals = 2) {
  const n = parseFloat(num);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function fmtCurrency(num) { const n = parseFloat(num); return isNaN(n) ? '—' : '$' + fmt(n); }
function fmtDate(s) { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
function fmtDateTime(s) { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
function isOverdue(s) { return s && new Date(s) < new Date(); }
function escHtml(str) { if (str == null) return ''; return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function daysUntil(s) { if (!s) return null; const d = Math.ceil((new Date(s) - new Date()) / 86400000); return d; }

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function setConnectionStatus(online) {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  dot.className = 'conn-dot ' + (online ? 'online' : 'offline');
  label.textContent = online ? 'Connected' : 'Offline';
}

// ══════════════════════════════════════════════════════════════════════════
// DATA
// ══════════════════════════════════════════════════════════════════════════

async function fetchLiveInventory() {
  try {
    const res = await fetch(`${API}/live`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.liveData = data.items || [];
    setConnectionStatus(true);
    renderAll();
  } catch (err) {
    setConnectionStatus(false);
    showToast('Could not load inventory: ' + err.message, 'error');
  }
}

async function fetchHistory() {
  try {
    const res = await fetch(`${API}/history?limit=1000`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.historyData = (await res.json()).history || [];
    renderHistoryTable(state.historyData);
  } catch (err) {
    showToast('Could not load history: ' + err.message, 'error');
  }
}

async function refreshAll() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('refreshing');
  await fetchLiveInventory();
  if (document.getElementById('history-modal').classList.contains('open')) await fetchHistory();
  btn.classList.remove('refreshing');
}

function shopItems(shop) { return state.liveData.filter(r => r.shop_type === shop); }

// ══════════════════════════════════════════════════════════════════════════
// VIEW ROUTING
// ══════════════════════════════════════════════════════════════════════════

function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  ['dashboard', 'bags', 'bridal', 'reconcile'].forEach(v => {
    document.getElementById('nav-' + v).classList.toggle('active', v === view);
  });
  renderAll();
}

function setBridalTab(tab) {
  state.bridalTab = tab;
  document.getElementById('bridal-tab-sales').classList.toggle('active', tab === 'sales');
  document.getElementById('bridal-tab-rentals').classList.toggle('active', tab === 'rentals');
  document.getElementById('bridal-sales-panel').classList.toggle('active', tab === 'sales');
  document.getElementById('bridal-rentals-panel').classList.toggle('active', tab === 'rentals');
  if (tab === 'rentals') renderRentalBoard();
}

function renderAll() {
  renderDashboard();
  renderBagsView();
  renderBridalSales();
  renderReconcile();
  if (state.bridalTab === 'rentals') renderRentalBoard();
}

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════

function renderDashboard() {
  const all = state.liveData;
  const bags = shopItems('Bags');
  const bridal = shopItems('Bridal');
  const totalStock = all.reduce((s, r) => s + parseInt(r.live_stock || 0), 0);
  const totalProfit = all.reduce((s, r) => s + parseFloat(r.total_gross_profit || 0), 0);
  const rentals = all.filter(r => r.bridal_status === 'Rented');
  const overdue = rentals.filter(r => isOverdue(r.rental_due_date));

  document.getElementById('dash-items').textContent = all.length;
  document.getElementById('dash-items-sub').textContent = `${bags.length} bags · ${bridal.length} bridal`;
  document.getElementById('dash-stock').textContent = totalStock;
  document.getElementById('dash-profit').textContent = fmtCurrency(totalProfit);
  document.getElementById('dash-rentals').textContent = rentals.length;
  document.getElementById('dash-rentals-sub').textContent = overdue.length ? `⚠️ ${overdue.length} overdue` : 'Outstanding';

  document.getElementById('dash-bags-summary').innerHTML = shopSummaryCard(bags, 'Bags');
  document.getElementById('dash-bridal-summary').innerHTML = shopSummaryCard(bridal, 'Bridal');

  // Upcoming returns board
  const sorted = [...rentals].sort((a, b) => new Date(a.rental_due_date || '9999') - new Date(b.rental_due_date || '9999'));
  document.getElementById('dash-returns-board').innerHTML = sorted.length
    ? `<div class="rental-list">${sorted.map(r => rentalCard(r, false)).join('')}</div>`
    : emptyState('✅', 'All clear', 'No active rentals');
}

function shopSummaryCard(items, shop) {
  const stock = items.reduce((s, r) => s + parseInt(r.live_stock || 0), 0);
  const profit = items.reduce((s, r) => s + parseFloat(r.total_gross_profit || 0), 0);
  const low = items.filter(r => parseInt(r.live_stock) <= parseInt(r.min_stock_alert || 2)).length;
  return `
    <div class="summary-line"><span>Items</span><strong>${items.length}</strong></div>
    <div class="summary-line"><span>Stock on hand</span><strong>${stock}</strong></div>
    <div class="summary-line"><span>Gross profit</span><strong class="money profit">${fmtCurrency(profit)}</strong></div>
    ${shop === 'Bags' ? `<div class="summary-line"><span>Low stock</span><strong>${low}</strong></div>` : ''}
  `;
}

// ══════════════════════════════════════════════════════════════════════════
// BAGS SHOP VIEW
// ══════════════════════════════════════════════════════════════════════════

function renderBagsView() {
  const bags = shopItems('Bags');
  const stock = bags.reduce((s, r) => s + parseInt(r.live_stock || 0), 0);
  const profit = bags.reduce((s, r) => s + parseFloat(r.total_gross_profit || 0), 0);
  const low = bags.filter(r => parseInt(r.live_stock) <= parseInt(r.min_stock_alert || 2));
  document.getElementById('bags-stats').innerHTML = `
    ${statCard('Items', bags.length, 'orange')}
    ${statCard('Stock', stock, 'green')}
    ${statCard('Gross Profit', fmtCurrency(profit), 'blue')}
    ${statCard('Low Stock', low.length, 'red')}
  `;
  renderShopTable('bags-table', bags, 'Bags', 'bags-search');
}

// ══════════════════════════════════════════════════════════════════════════
// BRIDAL SALES VIEW
// ══════════════════════════════════════════════════════════════════════════

function renderBridalSales() {
  const bridal = shopItems('Bridal');
  const stock = bridal.reduce((s, r) => s + parseInt(r.live_stock || 0), 0);
  const profit = bridal.reduce((s, r) => s + parseFloat(r.total_gross_profit || 0), 0);
  const rented = bridal.filter(r => r.bridal_status === 'Rented').length;
  document.getElementById('bridal-stats').innerHTML = `
    ${statCard('Items', bridal.length, 'orange')}
    ${statCard('Stock', stock, 'green')}
    ${statCard('Gross Profit', fmtCurrency(profit), 'blue')}
    ${statCard('Rented', rented, 'red')}
  `;
  renderShopTable('bridal-table', bridal, 'Bridal', 'bridal-search');
}

// ══════════════════════════════════════════════════════════════════════════
// SHOP TABLE (shared, with Update/Delete)
// ══════════════════════════════════════════════════════════════════════════

function renderShopTable(tableId, data, shop, searchId) {
  const search = (document.getElementById(searchId)?.value || '').toLowerCase();
  let filtered = data;
  if (search) {
    filtered = data.filter(r =>
      (r.item_sku || '').toLowerCase().includes(search) ||
      (r.item_name || '').toLowerCase().includes(search) ||
      (r.brand_designer || '').toLowerCase().includes(search) ||
      (r.bag_color || '').toLowerCase().includes(search));
  }
  const head = document.getElementById(tableId.replace('-table', '-table-head'));
  const body = document.getElementById(tableId.replace('-table', '-table-body'));

  if (shop === 'Bags') {
    head.innerHTML = `<th>SKU</th><th>Item</th><th>Brand</th><th>Color</th><th>Stock</th><th>Cost</th><th>Price</th><th>Profit</th><th>Margin</th><th>Updated</th><th class="th-actions">Actions</th>`;
  } else {
    head.innerHTML = `<th>SKU</th><th>Gown</th><th>Designer</th><th>Size</th><th>Status</th><th>Cost</th><th>Price</th><th>Profit</th><th>Margin</th><th>Updated</th><th class="th-actions">Actions</th>`;
  }

  if (filtered.length === 0) {
    body.innerHTML = `<tr><td colspan="11">${emptyState(shop === 'Bags' ? '👜' : '👗', 'No items found', 'Use the buttons above to add items or record sales')}</td></tr>`;
    return;
  }

  body.innerHTML = filtered.map(r => {
    const stock = parseInt(r.live_stock || 0);
    const minAlert = parseInt(r.min_stock_alert || 2);
    const isLow = stock <= minAlert && shop === 'Bags';
    const overdue = isOverdue(r.rental_due_date) && r.bridal_status === 'Rented';
    const rowClass = overdue ? 'overdue' : isLow ? 'low-stock' : '';
    const margin = parseFloat(r.profit_margin || 0);
    const marginBar = `<div class="margin-bar"><div class="margin-track"><div class="margin-fill" style="width:${Math.min(margin,100)}%;"></div></div><span class="margin-text">${fmt(margin,1)}%</span></div>`;
    const actions = `<td class="row-actions">
      <button class="row-action-btn" onclick="quickUpdate('${escHtml(r.item_sku)}','${shop}')" title="Update"><i class="ri-edit-line"></i></button>
      <button class="row-action-btn danger" onclick="deleteItem('${escHtml(r.item_sku)}','${shop}')" title="Delete"><i class="ri-delete-bin-line"></i></button>
    </td>`;
    const updated = `<td class="muted">${fmtDate(r.last_updated)}</td>`;

    if (shop === 'Bags') {
      const sc = stock === 0 ? 'zero' : stock <= minAlert ? 'low' : 'good';
      const si = stock === 0 ? '🔴' : stock <= minAlert ? '🟡' : '🟢';
      return `<tr class="${rowClass}">
        <td class="sku">${escHtml(r.item_sku)}</td>
        <td><strong>${escHtml(r.item_name)}</strong></td>
        <td class="muted">${escHtml(r.brand_designer || '—')}</td>
        <td>${r.bag_color ? `<div class="color-swatch"><span class="swatch-dot" style="background:${getColorHex(r.bag_color)};"></span>${escHtml(r.bag_color)}</div>` : '<span class="muted">—</span>'}</td>
        <td><span class="stock-count ${sc}">${si} ${stock}</span></td>
        <td class="money">${fmtCurrency(r.stock_cost_price)}</td>
        <td class="money">${fmtCurrency(r.sell_price)}</td>
        <td class="money profit">${fmtCurrency(r.total_gross_profit)}</td>
        <td>${marginBar}</td>${updated}${actions}</tr>`;
    } else {
      return `<tr class="${rowClass}">
        <td class="sku">${escHtml(r.item_sku)}</td>
        <td><strong>${escHtml(r.item_name)}</strong></td>
        <td class="muted">${escHtml(r.brand_designer || '—')}</td>
        <td class="muted">${escHtml(r.bridal_size || '—')}</td>
        <td>${getBridalStatusBadge(r.bridal_status, overdue)}</td>
        <td class="money">${fmtCurrency(r.stock_cost_price)}</td>
        <td class="money">${fmtCurrency(r.sell_price)}</td>
        <td class="money profit">${fmtCurrency(r.total_gross_profit)}</td>
        <td>${marginBar}</td>${updated}${actions}</tr>`;
    }
  }).join('');
}

function statCard(label, value, color) {
  return `<div class="stat-card ${color}"><div class="stat-label">${label}</div><div class="stat-value ${color}">${value}</div></div>`;
}

function emptyState(icon, title, sub) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;
}

// ══════════════════════════════════════════════════════════════════════════
// RENTAL MODULE (Bridal)
// ══════════════════════════════════════════════════════════════════════════

function renderRentalBoard() {
  const filter = document.getElementById('rental-status-filter')?.value || 'Rented';
  const bridal = shopItems('Bridal');
  const available = bridal.filter(r => r.bridal_status === 'Available').length;
  const rented = bridal.filter(r => r.bridal_status === 'Rented').length;
  const returned = bridal.filter(r => r.bridal_status === 'Returned').length;
  const overdue = bridal.filter(r => r.bridal_status === 'Rented' && isOverdue(r.rental_due_date)).length;

  document.getElementById('rental-stats').innerHTML = `
    ${statCard('Available', available, 'green')}
    ${statCard('Rented', rented, 'orange')}
    ${statCard('Returned', returned, 'blue')}
    ${statCard('Overdue', overdue, 'red')}
  `;

  let items = bridal;
  if (filter === 'overdue') items = bridal.filter(r => r.bridal_status === 'Rented' && isOverdue(r.rental_due_date));
  else if (filter !== 'all') items = bridal.filter(r => r.bridal_status === filter);

  const titles = { Rented: 'Active Rentals', Available: 'Available Items', Returned: 'Returned Items', overdue: 'Overdue Rentals', all: 'All Bridal Items' };
  document.getElementById('rental-board-title').textContent = titles[filter] || 'Items';

  // Sort: by due date ascending (upcoming first) for rented, else by name
  items = [...items].sort((a, b) => {
    if (filter === 'Rented' || filter === 'overdue' || filter === 'all') {
      const da = a.rental_due_date || '9999', db = b.rental_due_date || '9999';
      if (da !== db) return new Date(da) - new Date(db);
    }
    return (a.item_name || '').localeCompare(b.item_name || '');
  });

  document.getElementById('rental-board').innerHTML = items.length
    ? `<div class="rental-list">${items.map(r => rentalCard(r, true)).join('')}</div>`
    : emptyState('📭', 'No items', `No ${filter === 'all' ? '' : filter.toLowerCase() + ' '}items to show`);
}

function rentalCard(r, withReturnBtn) {
  const overdue = r.bridal_status === 'Rented' && isOverdue(r.rental_due_date);
  const days = daysUntil(r.rental_due_date);
  const showReturn = withReturnBtn && r.bridal_status === 'Rented';
  return `
    <div class="rental-item ${overdue ? 'overdue' : ''}">
      <div class="rental-item-top">
        <span class="rental-name">${escHtml(r.item_name)}</span>
        ${getBridalStatusBadge(r.bridal_status, overdue)}
      </div>
      <div class="rental-meta"><strong>${escHtml(r.item_sku)}</strong>${r.bridal_size ? ` · Size ${escHtml(r.bridal_size)}` : ''}${r.brand_designer ? ` · ${escHtml(r.brand_designer)}` : ''}</div>
      ${r.customer_name_contact ? `<div class="rental-meta">👤 ${escHtml(r.customer_name_contact)}</div>` : ''}
      ${r.rental_due_date ? `<div class="rental-meta" style="${overdue ? 'color:var(--red);font-weight:600;' : ''}">📅 Due: ${fmtDate(r.rental_due_date)}${r.bridal_status === 'Rented' ? (overdue ? ` · ⚠️ ${Math.abs(days)}d overdue` : (days <= 3 ? ` · ${days}d left` : '')) : ''}</div>` : ''}
      ${showReturn ? `<button class="btn-secondary btn-sm" style="margin-top:8px;" onclick="processReturn('${escHtml(r.item_sku)}')"><i class="ri-arrow-go-back-line"></i> Process Return</button>` : ''}
    </div>`;
}

function processReturn(sku) {
  openActionModal('return_rental', 'Bridal', sku);
}

// ══════════════════════════════════════════════════════════════════════════
// ACTION MODAL (dynamic forms)
// ══════════════════════════════════════════════════════════════════════════

let currentAction = null;

function openActionModal(action, shop, presetSku) {
  currentAction = { action, shop, presetSku };
  const titles = {
    new_item: 'Add New Item', restock: 'Restock Item', record_sale: 'Record Sale',
    new_rental: 'New Rental', return_rental: 'Process Rental Return', status_change: 'Change Status',
  };
  document.getElementById('action-modal-title').textContent = `${titles[action]} — ${shop === 'Bags' ? 'Bags Shop' : 'Bridal Shop'}`;
  document.getElementById('action-modal-body').innerHTML = buildActionForm(action, shop, presetSku);
  document.getElementById('action-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeActionModal() {
  document.getElementById('action-modal').classList.remove('open');
  document.body.style.overflow = '';
  currentAction = null;
}

function productOptions(items, includeBlank = true) {
  let opts = includeBlank ? '<option value="">— Select product —</option>' : '';
  items.forEach(r => {
    opts += `<option value="${escHtml(r.item_sku)}">${escHtml(r.item_name)} (${escHtml(r.item_sku)})${r.live_stock != null ? ' · stock ' + r.live_stock : ''}${r.bridal_status ? ' · ' + r.bridal_status : ''}</option>`;
  });
  return opts;
}

function field(label, inner, hint = '') {
  return `<div class="form-group"><label class="form-label">${label}</label>${inner}${hint ? `<div class="form-hint">${hint}</div>` : ''}</div>`;
}
function input(id, type = 'text', extra = '') { return `<input class="form-input" type="${type}" id="${id}" ${extra}>`; }
function select(id, optionsHtml) { return `<select class="form-select" id="${id}">${optionsHtml}</select>`; }

function buildActionForm(action, shop, presetSku) {
  const items = shopItems(shop);
  const allItems = state.liveData; // for rental: all inventory including accessories

  if (action === 'new_item') {
    if (shop === 'Bags') {
      return formWrap(`
        ${field('SKU *', input('f_sku', 'text', 'placeholder="BAG-001" required'))}
        ${field('Item Name *', input('f_name', 'text', 'placeholder="Classic Leather Tote" required'))}
        ${row(field('Brand', input('f_brand', 'text', 'placeholder="Gucci"')), field('Color', input('f_color', 'text', 'placeholder="Black"')))}
        ${row(field('Cost Price *', input('f_cost', 'number', 'placeholder="0.00" min="0" step="0.01" required')), field('Sell Price', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')))}
        ${row(field('Quantity *', input('f_qty', 'number', 'placeholder="5" required')), field('Low Stock Alert', input('f_min', 'number', 'value="2" min="0"')))}
        ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
      `);
    } else {
      return formWrap(`
        ${field('SKU *', input('f_sku', 'text', 'placeholder="GOWN-001" required'))}
        ${field('Gown/Item Name *', input('f_name', 'text', 'placeholder="Lace Mermaid Gown" required'))}
        ${row(field('Designer', input('f_brand', 'text', 'placeholder="Vera Wang"')), field('Size', input('f_size', 'text', 'placeholder="UK 10"')))}
        ${row(field('Cost Price *', input('f_cost', 'number', 'placeholder="0.00" min="0" step="0.01" required')), field('Sell/Rental Price', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')))}
        ${row(field('Quantity', input('f_qty', 'number', 'value="1"')), field('Status', select('f_status', statusOptions('Available'))))}
        ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
      `);
    }
  }

  if (action === 'restock') {
    return formWrap(`
      ${field('Select Product *', select('f_sku', productOptions(items)), 'Choose an existing item to restock')}
      ${row(field('Quantity to Add *', input('f_qty', 'number', 'placeholder="5" required')), field('Cost Price', input('f_cost', 'number', 'placeholder="0.00" min="0" step="0.01"')))}
      ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
    `);
  }

  if (action === 'record_sale') {
    const sellable = items.filter(r => parseInt(r.live_stock || 0) > 0);
    return formWrap(`
      ${field('Select Product *', select('f_sku', productOptions(sellable)), 'Only items with stock available are shown')}
      ${row(field('Quantity Sold *', input('f_qty', 'number', 'placeholder="1" min="1" required')), field('Sell Price', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')))}
      ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
    `);
  }

  if (action === 'new_rental') {
    // Available items from bridal inventory (all items, including accessories, that are Available)
    const available = allItems.filter(r => !r.bridal_status || r.bridal_status === 'Available');
    return formWrap(`
      ${field('Select Available Item *', select('f_sku', productOptions(available)), 'Choose an available item from inventory to rent out')}
      ${row(field('Customer Name & Contact *', input('f_customer', 'text', 'placeholder="Name — Phone / Email" required')), field('Return Due Date *', input('f_due', 'date', 'required')))}
      ${row(field('Rental Price', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')), field('Quantity', input('f_qty', 'number', 'value="1"')))}
      ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
    `);
  }

  if (action === 'return_rental') {
    const rented = items.filter(r => r.bridal_status === 'Rented');
    return formWrap(`
      ${field('Select Rented Item *', select('f_sku', productOptions(rented), false), 'Choose the item being returned')}
      ${row(field('Return Status', select('f_status', statusOptions('Returned'))), field('Late Fee (optional)', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')))}
      ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
    `);
  }

  if (action === 'status_change') {
    return formWrap(`
      ${field('Select Product *', select('f_sku', productOptions(items)))}
      ${field('New Status', select('f_status', statusOptions('Available')))}
      ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
    `);
  }

  return '<p>Unknown action.</p>';
}

function statusOptions(current) {
  return VALID_STATUSES.map(s => `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`).join('');
}
function row(a, b) { return `<div class="form-row">${a}${b}</div>`; }
function formWrap(inner) { return `<form id="action-form" onsubmit="submitAction(event)">${inner}<button type="submit" class="btn-primary" style="margin-top:8px;"><i class="ri-check-line"></i> Submit</button></form>`; }

async function submitAction(e) {
  e.preventDefault();
  const { action, shop } = currentAction;
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const body = { shop_type: shop };
  let actionType = '';

  try {
    if (action === 'new_item') {
      actionType = 'New Item';
      body.item_sku = val('f_sku'); body.item_name = val('f_name'); body.brand_designer = val('f_brand') || null;
      body.stock_cost_price = val('f_cost') || 0; body.sell_price = val('f_sell') || 0;
      body.quantity_change = val('f_qty') || 0; body.notes = val('f_notes') || null;
      if (shop === 'Bags') { body.bag_color = val('f_color') || null; body.min_stock_alert = val('f_min') || 2; }
      else { body.bridal_size = val('f_size') || null; body.bridal_status = val('f_status') || null; }
    } else if (action === 'restock') {
      actionType = 'Restock';
      const item = itemsBySku(val('f_sku'), shop);
      body.item_sku = val('f_sku'); body.item_name = item?.item_name; body.brand_designer = item?.brand_designer || null;
      body.bag_color = item?.bag_color || null; body.bridal_size = item?.bridal_size || null;
      body.stock_cost_price = val('f_cost') || 0; body.quantity_change = val('f_qty') || 0; body.notes = val('f_notes') || null;
    } else if (action === 'record_sale') {
      actionType = 'Retail Sale';
      const item = itemsBySku(val('f_sku'), shop);
      body.item_sku = val('f_sku'); body.item_name = item?.item_name; body.brand_designer = item?.brand_designer || null;
      body.bag_color = item?.bag_color || null; body.bridal_size = item?.bridal_size || null;
      body.stock_cost_price = item?.stock_cost_price || 0; body.sell_price = val('f_sell') || item?.sell_price || 0;
      body.quantity_change = -Math.abs(parseInt(val('f_qty')) || 1); body.notes = val('f_notes') || null;
    } else if (action === 'new_rental') {
      actionType = 'Rental Out';
      const item = state.liveData.find(r => r.item_sku === val('f_sku'));
      body.item_sku = val('f_sku'); body.item_name = item?.item_name; body.brand_designer = item?.brand_designer || null;
      body.bridal_size = item?.bridal_size || null; body.bridal_status = 'Rented';
      body.stock_cost_price = 0; body.sell_price = val('f_sell') || 0;
      body.quantity_change = -Math.abs(parseInt(val('f_qty')) || 1);
      body.customer_name_contact = val('f_customer') || null; body.rental_due_date = val('f_due') || null;
      body.notes = val('f_notes') || null;
    } else if (action === 'return_rental') {
      actionType = 'Rental Return';
      const item = itemsBySku(val('f_sku'), shop);
      body.item_sku = val('f_sku'); body.item_name = item?.item_name; body.brand_designer = item?.brand_designer || null;
      body.bridal_size = item?.bridal_size || null; body.bridal_status = val('f_status') || 'Returned';
      body.stock_cost_price = 0; body.sell_price = val('f_sell') || 0; body.quantity_change = 1;
      body.customer_name_contact = item?.customer_name_contact || null; body.notes = val('f_notes') || null;
    } else if (action === 'status_change') {
      actionType = 'Status Change';
      const item = itemsBySku(val('f_sku'), shop);
      body.item_sku = val('f_sku'); body.item_name = item?.item_name; body.brand_designer = item?.brand_designer || null;
      body.bridal_size = item?.bridal_size || null; body.bridal_status = val('f_status') || null;
      body.stock_cost_price = 0; body.sell_price = 0; body.quantity_change = 0; body.notes = val('f_notes') || null;
    }

    body.action_type = actionType;
    if (!body.item_sku || !body.item_name) { showToast('Please complete the required fields.', 'error'); return; }

    const res = await fetch(`${API}/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.details?.join(', ') || data.error || 'Server error');

    showToast(data.message, 'success');
    closeActionModal();
    await refreshAll();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function itemsBySku(sku, shop) { return state.liveData.find(r => r.item_sku === sku && (shop ? r.shop_type === shop : true)); }

// Quick update from row icon → open a relevant action modal
function quickUpdate(sku, shop) {
  const item = itemsBySku(sku, shop);
  if (!item) return;
  if (shop === 'Bags') openActionModal('restock', 'Bags');
  else openActionModal('status_change', 'Bridal');
  // pre-select the item
  setTimeout(() => { const sel = document.getElementById('f_sku'); if (sel) { sel.value = sku; } }, 0);
}

async function deleteItem(sku, shop) {
  if (!confirm(`Delete ALL transaction history for SKU ${sku}?\nThis cannot be undone.`)) return;
  try {
    const res = await fetch(`${API}/item/${encodeURIComponent(sku)}?shop_type=${shop}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    showToast(data.message, 'success');
    await refreshAll();
  } catch (err) { showToast(`Delete failed: ${err.message}`, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════
// IMPORT / EXPORT
// ══════════════════════════════════════════════════════════════════════════

function buildExportRows(shop) {
  return shopItems(shop).map(r => ({
    shop_type: r.shop_type, item_sku: r.item_sku, item_name: r.item_name, brand_designer: r.brand_designer || '',
    stock_cost_price: r.stock_cost_price, sell_price: r.sell_price, live_stock: r.live_stock,
    min_stock_alert: r.min_stock_alert, bag_color: r.bag_color || '', bridal_size: r.bridal_size || '',
    bridal_status: r.bridal_status || '', rental_due_date: r.rental_due_date || '',
    customer_name_contact: r.customer_name_contact || '', last_action: r.last_action,
    total_gross_profit: r.total_gross_profit, profit_margin: r.profit_margin,
  }));
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function exportData(format, shop) {
  const rows = buildExportRows(shop);
  if (!rows.length) { showToast('No items to export.', 'error'); return; }
  const base = `inventory-${shop.toLowerCase()}-${new Date().toISOString().slice(0,10)}`;
  if (format === 'csv') {
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => { const v = r[h] == null ? '' : String(r[h]); return /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v; }).join(','))].join('\n');
    downloadBlob(csv, `${base}.csv`, 'text/csv;charset=utf-8;');
    showToast(`Exported ${rows.length} rows to CSV`, 'success');
  } else if (format === 'xlsx') {
    if (typeof XLSX === 'undefined') { showToast('Excel library not loaded.', 'error'); return; }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), shop);
    XLSX.writeFile(wb, `${base}.xlsx`); showToast(`Exported ${rows.length} rows to Excel`, 'success');
  }
}

function parseCsvText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') { inQ = !inQ; continue; } if (c === ',' && !inQ) { vals.push(cur); cur = ''; continue; } cur += c; }
    vals.push(cur); const obj = {}; headers.forEach((h, i) => obj[h] = (vals[i] || '').trim()); return obj;
  });
}

async function importData(event) {
  const file = event.target.files[0]; if (!file) return; event.target.value = '';
  try {
    let rows = [];
    if (/\.xlsx?$/.test(file.name)) {
      if (typeof XLSX === 'undefined') { showToast('Excel library not loaded.', 'error'); return; }
      rows = XLSX.utils.sheet_to_json(XLSX.read(await file.arrayBuffer(), { type: 'array' }).Sheets[0] || {});
    } else { rows = parseCsvText(await file.text()); }
    if (!rows.length) { showToast('No rows found.', 'error'); return; }
    let ok = 0, fail = 0;
    for (const row of rows) {
      const body = {
        shop_type: row.shop_type || 'Bags', item_sku: row.item_sku || row.sku, item_name: row.item_name || row.name,
        brand_designer: row.brand_designer || '', stock_cost_price: row.stock_cost_price || row.cost || 0,
        sell_price: row.sell_price || row.price || 0, quantity_change: row.quantity_change || row.qty_change || 0,
        bag_color: row.bag_color || '', min_stock_alert: row.min_stock_alert || 2, bridal_size: row.bridal_size || '',
        bridal_status: row.bridal_status || '', rental_due_date: row.rental_due_date || '',
        customer_name_contact: row.customer_name_contact || '', action_type: row.action_type || 'New Item', notes: row.notes || '',
      };
      if (!body.item_sku || !body.item_name) { fail++; continue; }
      try { const res = await fetch(`${API}/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); res.ok ? ok++ : fail++; } catch { fail++; }
    }
    showToast(`Import complete: ${ok} added, ${fail} failed`, ok > 0 ? 'success' : 'error');
    await refreshAll();
  } catch (err) { showToast(`Import failed: ${err.message}`, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════
// AUDIT TRAIL
// ══════════════════════════════════════════════════════════════════════════

function openHistoryModal() { document.getElementById('history-modal').classList.add('open'); fetchHistory(); document.body.style.overflow = 'hidden'; }
function closeHistoryModal() { document.getElementById('history-modal').classList.remove('open'); document.body.style.overflow = ''; }

function renderHistoryTable(data) {
  const search = (document.getElementById('history-search')?.value || '').toLowerCase();
  let filtered = data;
  if (search) filtered = data.filter(r => ['item_sku','item_name','action_type','customer_name_contact','notes'].some(k => (r[k]||'').toLowerCase().includes(search)));
  const body = document.getElementById('history-table-body');
  if (!filtered.length) { body.innerHTML = `<tr><td colspan="13">${emptyState('📭','No records found','')}</td></tr>`; return; }
  body.innerHTML = filtered.map(r => {
    const margin = parseFloat(r.profit_margin || 0);
    return `<tr>
      <td class="muted" style="white-space:nowrap;">${fmtDateTime(r.created_at)}</td>
      <td><span class="badge ${r.shop_type === 'Bags' ? 'badge-new' : 'badge-alteration'}">${r.shop_type === 'Bags' ? '👜' : '👗'} ${escHtml(r.shop_type)}</span></td>
      <td class="sku">${escHtml(r.item_sku)}</td><td style="max-width:180px;"><strong>${escHtml(r.item_name)}</strong></td>
      <td>${getActionBadge(r.action_type)}</td>
      <td class="money" style="${parseInt(r.quantity_change) < 0 ? 'color:var(--red);' : 'color:var(--green);'}">${parseInt(r.quantity_change) > 0 ? '+' : ''}${r.quantity_change}</td>
      <td class="money muted">${fmtCurrency(r.stock_cost_price)}</td><td class="money">${fmtCurrency(r.sell_price)}</td>
      <td class="money profit">${fmtCurrency(r.gross_profit)}</td>
      <td style="white-space:nowrap;"><span style="font-size:12px;font-weight:700;color:${margin >= 50 ? 'var(--green)' : margin >= 20 ? 'var(--orange)' : 'var(--red)'}">${fmt(margin,1)}%</span></td>
      <td>${getBridalStatusBadge(r.bridal_status)}</td>
      <td class="muted" style="max-width:150px;font-size:12px;">${escHtml(r.customer_name_contact || '—')}</td>
      <td class="muted" style="max-width:200px;font-size:12px;">${escHtml(r.notes || '—')}</td></tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// BADGES / COLOR
// ══════════════════════════════════════════════════════════════════════════

function getBridalStatusBadge(status, overdue = false) {
  if (!status) return '<span class="muted">—</span>';
  if (overdue) return `<span class="badge badge-overdue">⚠️ ${escHtml(status)}</span>`;
  const map = { Available:'badge-available', Rented:'badge-rented', Returned:'badge-return', 'In Alteration':'badge-alteration', 'Dry Cleaning':'badge-cleaning', Sold:'badge-sold' };
  return `<span class="badge ${map[status] || ''}">${escHtml(status)}</span>`;
}
function getActionBadge(action) {
  const map = { 'New Item':['badge-new','✨'], Restock:['badge-restock','📦'], 'Retail Sale':['badge-sale','🛒'], 'Rental Out':['badge-rented','🎁'], 'Rental Return':['badge-return','↩️'], 'Status Change':['badge-status','🔄'] };
  const [cls, icon] = map[action] || ['', '•'];
  return `<span class="badge ${cls}">${icon} ${escHtml(action)}</span>`;
}
function getColorHex(c) {
  const map = { black:'#1A1A1A', white:'#F5F5F5', red:'#DC2626', blue:'#2563EB', green:'#16A34A', yellow:'#CA8A04', pink:'#EC4899', purple:'#7C3AED', brown:'#92400E', tan:'#D97706', navy:'#1E3A5F', grey:'#6B7280', gray:'#6B7280', beige:'#D4B483', gold:'#F59E0B', silver:'#94A3B8', orange:'#FF7A00', cream:'#FEFCE8', nude:'#E8C9A0', camel:'#C19A6B' };
  return map[(c || '').toLowerCase().replace(/\s/g, '')] || '#999';
}

// ══════════════════════════════════════════════════════════════════════════
// STOCK TAKE / RECONCILIATION
// ══════════════════════════════════════════════════════════════════════════

function setReconcileShop(shop) {
  state.reconcileShop = shop;
  state.reconcileCounts = {};
  document.getElementById('reconcile-tab-bags').classList.toggle('active', shop === 'Bags');
  document.getElementById('reconcile-tab-bridal').classList.toggle('active', shop === 'Bridal');
  renderReconcile();
}

function rentedCount(r) {
  // Bridal items: 1 if status Rented, else 0. Bags don't track rentals.
  return r.bridal_status === 'Rented' ? 1 : 0;
}

function renderReconcile() {
  const shop = state.reconcileShop;
  const items = shopItems(shop);
  document.getElementById('reconcile-table-title').textContent = `Stock Take — ${shop === 'Bags' ? 'Bags Shop' : 'Bridal Shop'}`;

  let totalSurplus = 0, totalShortage = 0, totalMatched = 0, totalPending = 0;
  const counts = state.reconcileCounts;

  const body = document.getElementById('reconcile-table-body');
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8">${emptyState('📭', 'No items', 'Add items to this shop first')}</td></tr>`;
    document.getElementById('reconcile-stats').innerHTML = '';
    return;
  }

  body.innerHTML = items.map(r => {
    const sysAvail = parseInt(r.live_stock || 0);
    const sysRented = rentedCount(r);
    const counted = counts[r.item_sku];
    const hasCount = counted != null && counted !== '';
    const variance = hasCount ? (parseInt(counted) - sysAvail) : null;
    const varianceCell = variance == null
      ? '<span class="muted">—</span>'
      : `<span class="${variance > 0 ? 'variance-surplus' : variance < 0 ? 'variance-shortage' : 'variance-ok'}">${variance > 0 ? '+' : ''}${variance}</span>`;
    const disposition = !hasCount ? '<span class="muted">Not counted</span>'
      : variance === 0 ? '<span class="badge badge-available">Matched</span>'
      : variance > 0 ? `<span class="badge badge-restock">Surplus — log Restock +${variance}</span>`
      : `<span class="badge badge-sale">Shortage — log adjustment ${variance}</span>`;
    const actionBtn = hasCount && variance !== 0
      ? `<button class="btn-primary btn-sm" onclick="resolveVariance('${escHtml(r.item_sku)}')"><i class="ri-check-line"></i> Resolve</button>`
      : '<span class="muted">—</span>';

    if (hasCount) {
      if (variance > 0) totalSurplus++; else if (variance < 0) totalShortage++; else totalMatched++;
    } else { totalPending++; }

    return `<tr>
      <td class="sku">${escHtml(r.item_sku)}</td>
      <td><strong>${escHtml(r.item_name)}</strong>${r.bridal_status ? ' ' + getBridalStatusBadge(r.bridal_status) : ''}</td>
      <td class="money">${sysAvail}</td>
      <td class="money">${sysRented}</td>
      <td><input class="form-input count-input" type="number" min="0" value="${hasCount ? escHtml(counted) : ''}" onchange="setCount('${escHtml(r.item_sku)}', this.value)" placeholder="0"></td>
      <td class="money">${varianceCell}</td>
      <td>${disposition}</td>
      <td class="row-actions">${actionBtn}</td>
    </tr>`;
  }).join('');

  document.getElementById('reconcile-stats').innerHTML = `
    ${statCard('Items', items.length, 'orange')}
    ${statCard('Matched', totalMatched, 'green')}
    ${statCard('Surplus', totalSurplus, 'blue')}
    ${statCard('Shortage', totalShortage, 'red')}
  `;
}

function setCount(sku, value) {
  state.reconcileCounts[sku] = value;
  renderReconcile();
}

async function resolveVariance(sku) {
  const shop = state.reconcileShop;
  const item = itemsBySku(sku, shop);
  if (!item) return;
  const sysAvail = parseInt(item.live_stock || 0);
  const counted = parseInt(state.reconcileCounts[sku]);
  if (isNaN(counted)) { showToast('Enter a valid count first.', 'error'); return; }
  const variance = counted - sysAvail;
  if (variance === 0) { showToast('No variance to resolve.', 'info'); return; }

  const isSurplus = variance > 0;
  const body = {
    shop_type: shop,
    item_sku: sku,
    item_name: item.item_name,
    brand_designer: item.brand_designer || null,
    bag_color: item.bag_color || null,
    bridal_size: item.bridal_size || null,
    bridal_status: item.bridal_status || null,
    action_type: isSurplus ? 'Restock' : 'Status Change',
    stock_cost_price: 0,
    sell_price: 0,
    quantity_change: variance,
    notes: `Stock take reconciliation ${new Date().toISOString().slice(0,10)}: ${isSurplus ? '+' : ''}${variance} units (physical ${counted} vs system ${sysAvail}). ${isSurplus ? 'Surplus — likely unlogged return or unrecorded stock.' : 'Shortage — possible loss/unlogged sale.'}`,
  };

  try {
    const res = await fetch(`${API}/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.details?.join(', ') || data.error || 'Server error');
    showToast(`Resolved ${sku}: ${isSurplus ? '+' : ''}${variance} logged`, 'success');
    delete state.reconcileCounts[sku];
    await refreshAll();
  } catch (err) {
    showToast(`Resolve failed: ${err.message}`, 'error');
  }
}

async function reconcileAll() {
  const shop = state.reconcileShop;
  const items = shopItems(shop);
  const pending = items.filter(r => {
    const c = state.reconcileCounts[r.item_sku];
    return c != null && c !== '' && (parseInt(c) - parseInt(r.live_stock || 0)) !== 0;
  });
  if (!pending.length) { showToast('No variances to reconcile. Enter physical counts first.', 'info'); return; }
  if (!confirm(`Reconcile ${pending.length} SKU(s) with variances? Each will be logged as a corrective transaction.`)) return;
  for (const r of pending) { await resolveVariance(r.item_sku); }
}

function exportCountSheet() {
  const shop = state.reconcileShop;
  const items = shopItems(shop);
  if (!items.length) { showToast('No items to export.', 'error'); return; }
  const rows = items.map(r => ({ item_sku: r.item_sku, item_name: r.item_name, system_available: r.live_stock, system_rented: rentedCount(r), physical_count: '' }));
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => { const v = r[h] == null ? '' : String(r[h]); return /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v; }).join(','))].join('\n');
  downloadBlob(csv, `count-sheet-${shop.toLowerCase()}-${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8;');
  showToast(`Exported ${rows.length} rows — fill the physical_count column and re-import`, 'success');
}

async function importCounts(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  try {
    const text = await file.text();
    const rows = parseCsvText(text);
    let n = 0;
    for (const row of rows) {
      const sku = row.item_sku || row.sku;
      const counted = row.physical_count != null ? row.physical_count : row.counted;
      if (sku && counted != null && counted !== '') { state.reconcileCounts[sku.toUpperCase()] = counted; n++; }
    }
    showToast(`Imported ${n} counts`, 'success');
    renderReconcile();
  } catch (err) { showToast(`Import failed: ${err.message}`, 'error'); }
}

// ══════════════════════════════════════════════════════════════════════════
// EVENT WIRING + INIT
// ══════════════════════════════════════════════════════════════════════════

document.getElementById('action-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeActionModal(); });
document.getElementById('history-modal').addEventListener('click', e => { if (e.target === e.currentTarget) closeHistoryModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeActionModal(); closeHistoryModal(); } });
document.getElementById('history-search').addEventListener('input', () => renderHistoryTable(state.historyData));
document.getElementById('bags-search').addEventListener('input', () => renderBagsView());
document.getElementById('bridal-search').addEventListener('input', () => renderBridalSales());

(async function init() {
  await fetchLiveInventory();
  setInterval(fetchLiveInventory, 60000);
})();
