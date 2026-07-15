/* =====================================================================
   InventoryOS — Frontend Application Logic
   Dual-Shop Inventory Management (Ladies Bags + Bridal)
   ===================================================================== */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  currentShop: 'Bags',
  currentTab:  'inventory',
  liveData:    [],
  historyData: [],
  allSkus:     [],
};

// ── API Base ───────────────────────────────────────────────────────────────
const API = '/api/inventory';

// ══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════════════════════════════

function fmt(num, decimals = 2) {
  const n = parseFloat(num);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCurrency(num) {
  const n = parseFloat(num);
  if (isNaN(n)) return '—';
  return '$' + fmt(n);
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
         ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr) < new Date();
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Toast Notifications ────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${escHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

// ── Connection Status ──────────────────────────────────────────────────────
function setConnectionStatus(online) {
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (online) {
    dot.className = 'conn-dot online';
    label.textContent = 'Connected';
  } else {
    dot.className = 'conn-dot offline';
    label.textContent = 'Offline';
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SHOP TOGGLE
// ══════════════════════════════════════════════════════════════════════════

function switchShop(shop) {
  state.currentShop = shop;

  // Toggle buttons
  document.getElementById('btn-bags').classList.toggle('active', shop === 'Bags');
  document.getElementById('btn-bridal').classList.toggle('active', shop === 'Bridal');
  document.getElementById('btn-bags').setAttribute('aria-pressed', shop === 'Bags');
  document.getElementById('btn-bridal').setAttribute('aria-pressed', shop === 'Bridal');

  // Update form title & shop field
  document.getElementById('form-title').textContent =
    `Log Action — ${shop === 'Bags' ? 'Ladies Bags' : 'Bridal Shop'}`;
  document.getElementById('shop_type_field').value = shop;

  // Update table label
  document.getElementById('table-shop-label').textContent =
    `${shop === 'Bags' ? 'Ladies Bags' : 'Bridal Shop'} — Live Inventory`;

  // Show/hide dynamic form fields
  toggleShopFields(shop);

  // Filter action type options based on shop
  updateActionTypeOptions(shop);

  // Reset SKU autocomplete for this shop
  updateSkuSuggestions();

  // Refresh table view
  renderLiveTable(state.liveData);
  renderSummary();
}

function toggleShopFields(shop) {
  const bagsFields   = document.getElementById('bags-fields');
  const bridalFields = document.getElementById('bridal-fields');

  if (shop === 'Bags') {
    bagsFields.classList.remove('hidden');
    bridalFields.classList.add('hidden');
  } else {
    bagsFields.classList.add('hidden');
    bridalFields.classList.remove('hidden');
  }
}

function updateActionTypeOptions(shop) {
  const sel = document.getElementById('action_type');
  const currentVal = sel.value;

  const bagActions    = ['New Item', 'Restock', 'Retail Sale', 'Status Change'];
  const bridalActions = ['New Item', 'Rental Out', 'Rental Return', 'Status Change', 'Retail Sale'];
  const allActions    = ['New Item', 'Restock', 'Retail Sale', 'Rental Out', 'Rental Return', 'Status Change'];

  const allowed = shop === 'Bags' ? bagActions : bridalActions;

  sel.innerHTML = '<option value="">— Select Action —</option>';
  allActions.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    if (!allowed.includes(a)) opt.disabled = true;
    if (a === currentVal && allowed.includes(a)) opt.selected = true;
    sel.appendChild(opt);
  });

  onActionTypeChange();
}

// ══════════════════════════════════════════════════════════════════════════
// DYNAMIC FORM FIELD VISIBILITY
// ══════════════════════════════════════════════════════════════════════════

function onActionTypeChange() {
  const action = document.getElementById('action_type').value;
  const rentalFields  = document.getElementById('rental-fields');
  const bridalStatus  = document.getElementById('bridal_status');
  const costInput     = document.getElementById('stock_cost_price');
  const costHint      = document.getElementById('cost-hint');
  const sellLabel     = document.getElementById('sell-price-label');
  const submitLabel   = document.getElementById('submit-label');
  const costRequired  = document.getElementById('cost-required');

  // Bridal rental-specific fields
  if (state.currentShop === 'Bridal') {
    if (action === 'Rental Out') {
      rentalFields.classList.remove('hidden');
      bridalStatus.value = 'Rented';
    } else if (action === 'Rental Return') {
      rentalFields.classList.add('hidden');
      bridalStatus.value = 'Available';
    } else {
      rentalFields.classList.add('hidden');
    }
  }

  // Financial field hints
  if (action === 'Rental Out') {
    costInput.value      = '0.00';
    costInput.readOnly   = true;
    costInput.style.background = '#f9f9f9';
    costHint.textContent = '⚡ Auto-set to 0 (item cost recorded on New Item)';
    sellLabel.textContent = 'Rental Price';
    costRequired.style.display = 'none';
  } else {
    costInput.readOnly   = false;
    costInput.style.background = '';
    costHint.textContent = 'Purchase / wholesale cost';
    sellLabel.textContent = action === 'Restock' ? 'Sell Price (optional)' : 'Sell Price';
    costRequired.style.display = action === 'New Item' ? '' : 'none';
  }

  // Qty sign hint
  if (action === 'Retail Sale') {
    document.getElementById('quantity_change').placeholder = 'e.g. -1 (negative)';
  } else if (action === 'Restock') {
    document.getElementById('quantity_change').placeholder = 'e.g. +5';
  } else {
    document.getElementById('quantity_change').placeholder = 'e.g. 1';
  }

  // Submit label
  const labels = {
    'New Item':      '➕ Add New Item',
    'Restock':       '📦 Log Restock',
    'Retail Sale':   '🛒 Record Sale',
    'Rental Out':    '🎁 Log Rental Out',
    'Rental Return': '↩️ Record Return',
    'Status Change': '🔄 Update Status',
  };
  submitLabel.textContent = labels[action] || 'Log Transaction';
}

// ══════════════════════════════════════════════════════════════════════════
// FORM SUBMISSION
// ══════════════════════════════════════════════════════════════════════════

document.getElementById('inventory-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="border-color:#fff3;border-top-color:#fff;"></div> Logging…';

  try {
    // Collect form data
    const fd = new FormData(this);
    const body = {};
    fd.forEach((v, k) => { if (v !== '') body[k] = v; });

    // Ensure shop_type is always set
    body.shop_type = state.currentShop;

    // Bridal: sync the hidden bridal quantity_change if needed
    if (state.currentShop === 'Bridal') {
      body.quantity_change = document.getElementById('quantity_change_bridal').value || 0;
    }

    // Validate required
    if (!body.item_sku || !body.item_name || !body.action_type) {
      showToast('Please fill in SKU, item name, and action type.', 'error');
      return;
    }

    const res = await fetch(`${API}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.details?.join(', ') || data.error || 'Server error');

    showToast(data.message, 'success');
    resetForm();
    await refreshAll();

  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
    setConnectionStatus(false);
  } finally {
    btn.disabled = false;
    onActionTypeChange(); // restore label
  }
});

function resetForm() {
  document.getElementById('inventory-form').reset();
  document.getElementById('shop_type_field').value = state.currentShop;
  document.getElementById('cost-hint').textContent = 'Purchase / wholesale cost';
  document.getElementById('sell-price-label').textContent = 'Sell Price';
  document.getElementById('rental-fields').classList.add('hidden');
  document.getElementById('stock_cost_price').readOnly = false;
  document.getElementById('stock_cost_price').style.background = '';
  document.getElementById('cost-required').style.display = '';
  document.getElementById('submit-label').textContent = 'Log Transaction';
}

// ══════════════════════════════════════════════════════════════════════════
// FETCH — LIVE INVENTORY
// ══════════════════════════════════════════════════════════════════════════

async function fetchLiveInventory() {
  try {
    const res = await fetch(`${API}/live`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.liveData = data.items || [];
    setConnectionStatus(true);

    // Extract all known SKUs for autocomplete
    state.allSkus = [...new Set(state.liveData.map(r => r.item_sku))];
    updateSkuSuggestions();

    renderSummary(data.summary);
    renderLiveTable(state.liveData);
    renderRentalPanel(state.liveData);
    if (state.currentTab === 'analytics') renderAnalytics(state.liveData);

  } catch (err) {
    setConnectionStatus(false);
    showToast('Could not load inventory: ' + err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FETCH — HISTORY
// ══════════════════════════════════════════════════════════════════════════

async function fetchHistory() {
  try {
    const res = await fetch(`${API}/history?limit=1000`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.historyData = data.history || [];
    renderHistoryTable(state.historyData);
  } catch (err) {
    showToast('Could not load history: ' + err.message, 'error');
  }
}

async function refreshAll() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('refreshing');
  await fetchLiveInventory();
  if (document.getElementById('history-modal').classList.contains('open')) {
    await fetchHistory();
  }
  btn.classList.remove('refreshing');
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER — SUMMARY STATS
// ══════════════════════════════════════════════════════════════════════════

function renderSummary(summary) {
  // Filter to current shop if not provided
  const shopData = state.liveData.filter(r => r.shop_type === state.currentShop);

  const totalStock  = shopData.reduce((s, r) => s + parseInt(r.live_stock || 0), 0);
  const totalProfit = shopData.reduce((s, r) => s + parseFloat(r.total_gross_profit || 0), 0);
  const rentals     = state.liveData.filter(r => r.bridal_status === 'Rented');
  const overdue     = rentals.filter(r => isOverdue(r.rental_due_date));
  const lowStock    = shopData.filter(r => parseInt(r.live_stock) <= parseInt(r.min_stock_alert));

  document.getElementById('stat-stock').textContent = totalStock;
  document.getElementById('stat-stock-sub').textContent =
    `${shopData.length} SKUs${lowStock.length ? ` · ⚠️ ${lowStock.length} low` : ''}`;

  document.getElementById('stat-profit').textContent = '$' + fmt(totalProfit);

  document.getElementById('stat-rentals').textContent = rentals.length;
  document.getElementById('stat-overdue-sub').textContent =
    overdue.length > 0 ? `⚠️ ${overdue.length} OVERDUE` : 'Outstanding';

  if (overdue.length > 0) {
    document.querySelector('#stat-rentals').closest('.stat-card').classList.add('overdue-pulse');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER — LIVE INVENTORY TABLE
// ══════════════════════════════════════════════════════════════════════════

function renderLiveTable(data) {
  const search = document.getElementById('table-search').value.toLowerCase();
  const shop = state.currentShop;

  let filtered = data.filter(r => r.shop_type === shop);
  if (search) {
    filtered = filtered.filter(r =>
      r.item_sku.toLowerCase().includes(search) ||
      r.item_name.toLowerCase().includes(search) ||
      (r.brand_designer || '').toLowerCase().includes(search) ||
      (r.bag_color || '').toLowerCase().includes(search)
    );
  }

  // Build headers
  const head = document.getElementById('live-table-head');
  const body = document.getElementById('live-table-body');

  if (shop === 'Bags') {
    head.innerHTML = `
      <th>SKU</th>
      <th>Item Name</th>
      <th>Brand</th>
      <th>Color</th>
      <th>Stock</th>
      <th>Cost</th>
      <th>Price</th>
      <th>Gross Profit</th>
      <th>Margin</th>
      <th>Last Action</th>
      <th>Updated</th>
    `;
  } else {
    head.innerHTML = `
      <th>SKU</th>
      <th>Gown Name</th>
      <th>Designer</th>
      <th>Size</th>
      <th>Status</th>
      <th>Cost</th>
      <th>Rental/Sell</th>
      <th>Gross Profit</th>
      <th>Margin</th>
      <th>Return Due</th>
      <th>Customer</th>
      <th>Last Action</th>
    `;
  }

  if (filtered.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="${shop === 'Bags' ? 11 : 12}">
          <div class="empty-state">
            <div class="empty-icon">${shop === 'Bags' ? '👜' : '👗'}</div>
            <div class="empty-title">No items found</div>
            <div class="empty-sub">Log your first item using the form on the left</div>
          </div>
        </td>
      </tr>`;
    return;
  }

  body.innerHTML = filtered.map(r => {
    const stock     = parseInt(r.live_stock || 0);
    const minAlert  = parseInt(r.min_stock_alert || 2);
    const isLow     = stock <= minAlert && shop === 'Bags';
    const overdue   = isOverdue(r.rental_due_date) && r.bridal_status === 'Rented';
    const rowClass  = overdue ? 'overdue' : isLow ? 'low-stock' : '';
    const margin    = parseFloat(r.profit_margin || 0);
    const marginBar = `
      <div class="margin-bar">
        <div class="margin-track">
          <div class="margin-fill" style="width:${Math.min(margin, 100)}%;"></div>
        </div>
        <span class="margin-text">${fmt(margin, 1)}%</span>
      </div>`;

    if (shop === 'Bags') {
      const stockClass = stock === 0 ? 'zero' : stock <= minAlert ? 'low' : 'good';
      const stockIcon  = stock === 0 ? '🔴' : stock <= minAlert ? '🟡' : '🟢';
      return `
        <tr class="${rowClass}">
          <td class="sku">${escHtml(r.item_sku)}</td>
          <td><strong>${escHtml(r.item_name)}</strong></td>
          <td class="muted">${escHtml(r.brand_designer || '—')}</td>
          <td>
            ${r.bag_color ? `<div class="color-swatch">
              <span class="swatch-dot" style="background:${getColorHex(r.bag_color)};"></span>
              ${escHtml(r.bag_color)}
            </div>` : '<span class="muted">—</span>'}
          </td>
          <td>
            <span class="stock-count ${stockClass}">
              ${stockIcon} ${stock}
            </span>
            ${isLow && stock > 0 ? '<span class="badge badge-low-stock" style="margin-left:4px;">Low</span>' : ''}
            ${stock === 0 ? '<span class="badge badge-sold" style="margin-left:4px;">Out</span>' : ''}
          </td>
          <td class="money">${fmtCurrency(r.stock_cost_price)}</td>
          <td class="money">${fmtCurrency(r.sell_price)}</td>
          <td class="money profit">${fmtCurrency(r.total_gross_profit)}</td>
          <td>${marginBar}</td>
          <td>${getActionBadge(r.last_action)}</td>
          <td class="muted">${fmtDate(r.last_updated)}</td>
        </tr>`;
    } else {
      return `
        <tr class="${rowClass}">
          <td class="sku">${escHtml(r.item_sku)}</td>
          <td><strong>${escHtml(r.item_name)}</strong></td>
          <td class="muted">${escHtml(r.brand_designer || '—')}</td>
          <td class="muted">${escHtml(r.bridal_size || '—')}</td>
          <td>${getBridalStatusBadge(r.bridal_status, overdue)}</td>
          <td class="money">${fmtCurrency(r.stock_cost_price)}</td>
          <td class="money">${fmtCurrency(r.sell_price)}</td>
          <td class="money profit">${fmtCurrency(r.total_gross_profit)}</td>
          <td>${marginBar}</td>
          <td class="${overdue ? 'money' : 'muted'}" style="${overdue ? 'color:var(--red);font-weight:700;' : ''}">
            ${r.rental_due_date ? fmtDate(r.rental_due_date) : '—'}
            ${overdue ? ' ⚠️' : ''}
          </td>
          <td class="muted">${escHtml(r.customer_name_contact || '—')}</td>
          <td>${getActionBadge(r.last_action)}</td>
        </tr>`;
    }
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER — RENTAL PANEL
// ══════════════════════════════════════════════════════════════════════════

function renderRentalPanel(data) {
  const rentals = data.filter(r => r.bridal_status === 'Rented');
  const badge   = document.getElementById('rental-count-badge');
  badge.textContent = rentals.length;

  const container = document.getElementById('rental-list-container');

  if (rentals.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:24px 12px;">
        <div class="empty-icon">✅</div>
        <div class="empty-title">All clear!</div>
        <div class="empty-sub">No active rentals</div>
      </div>`;
    return;
  }

  // Sort: overdue first
  const sorted = [...rentals].sort((a, b) => {
    const aOver = isOverdue(a.rental_due_date) ? 0 : 1;
    const bOver = isOverdue(b.rental_due_date) ? 0 : 1;
    return aOver - bOver;
  });

  container.innerHTML = `<div class="rental-list">${sorted.map(r => {
    const overdue = isOverdue(r.rental_due_date);
    return `
      <div class="rental-item ${overdue ? 'overdue' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <span class="rental-name">${escHtml(r.item_name)}</span>
          ${overdue ? '<span class="badge badge-overdue">⚠️ Overdue</span>' : ''}
        </div>
        <div class="rental-meta">
          <strong>${escHtml(r.item_sku)}</strong>
          ${r.bridal_size ? ` · Size ${escHtml(r.bridal_size)}` : ''}
        </div>
        ${r.customer_name_contact ? `<div class="rental-meta">👤 ${escHtml(r.customer_name_contact)}</div>` : ''}
        ${r.rental_due_date ? `<div class="rental-meta" style="${overdue ? 'color:var(--red);font-weight:600;' : ''}">
          📅 Due: ${fmtDate(r.rental_due_date)}
        </div>` : ''}
      </div>`;
  }).join('')}</div>`;
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER — HISTORY TABLE
// ══════════════════════════════════════════════════════════════════════════

function renderHistoryTable(data) {
  const search = document.getElementById('history-search').value.toLowerCase();
  let filtered = data;
  if (search) {
    filtered = data.filter(r =>
      (r.item_sku  || '').toLowerCase().includes(search) ||
      (r.item_name || '').toLowerCase().includes(search) ||
      (r.action_type || '').toLowerCase().includes(search) ||
      (r.customer_name_contact || '').toLowerCase().includes(search) ||
      (r.notes || '').toLowerCase().includes(search)
    );
  }

  const body = document.getElementById('history-table-body');

  if (filtered.length === 0) {
    body.innerHTML = `<tr><td colspan="13"><div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">No records found</div></div></td></tr>`;
    return;
  }

  body.innerHTML = filtered.map(r => {
    const margin = parseFloat(r.profit_margin || 0);
    return `
      <tr>
        <td class="muted" style="white-space:nowrap;">${fmtDateTime(r.created_at)}</td>
        <td>
          <span class="badge ${r.shop_type === 'Bags' ? 'badge-new' : 'badge-alteration'}">
            ${r.shop_type === 'Bags' ? '👜' : '👗'} ${escHtml(r.shop_type)}
          </span>
        </td>
        <td class="sku">${escHtml(r.item_sku)}</td>
        <td style="max-width:180px;"><strong>${escHtml(r.item_name)}</strong></td>
        <td>${getActionBadge(r.action_type)}</td>
        <td class="money" style="${parseInt(r.quantity_change) < 0 ? 'color:var(--red);' : 'color:var(--green);'}">
          ${parseInt(r.quantity_change) > 0 ? '+' : ''}${r.quantity_change}
        </td>
        <td class="money muted">${fmtCurrency(r.stock_cost_price)}</td>
        <td class="money">${fmtCurrency(r.sell_price)}</td>
        <td class="money profit">${fmtCurrency(r.gross_profit)}</td>
        <td style="white-space:nowrap;">
          <span style="font-size:12px;font-weight:700;color:${margin >= 50 ? 'var(--green)' : margin >= 20 ? 'var(--orange)' : 'var(--red)'}">
            ${fmt(margin, 1)}%
          </span>
        </td>
        <td>${getBridalStatusBadge(r.bridal_status)}</td>
        <td class="muted" style="max-width:150px;font-size:12px;">${escHtml(r.customer_name_contact || '—')}</td>
        <td class="muted" style="max-width:200px;font-size:12px;">${escHtml(r.notes || '—')}</td>
      </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER — ANALYTICS
// ══════════════════════════════════════════════════════════════════════════

function renderAnalytics(data) {
  const shopData = data.filter(r => r.shop_type === state.currentShop);
  if (shopData.length === 0) {
    document.getElementById('analytics-content').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <div class="empty-title">No data yet</div>
        <div class="empty-sub">Log some items to see analytics</div>
      </div>`;
    return;
  }

  const totalRevenue = shopData.reduce((s, r) => s + parseFloat(r.total_revenue || 0), 0);
  const totalProfit  = shopData.reduce((s, r) => s + parseFloat(r.total_gross_profit || 0), 0);
  const avgMargin    = shopData.reduce((s, r) => s + parseFloat(r.profit_margin || 0), 0) / shopData.length;

  // Sort by profit desc
  const sorted = [...shopData].sort((a, b) => parseFloat(b.total_gross_profit) - parseFloat(a.total_gross_profit));

  document.getElementById('analytics-content').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px;">
      <div class="stat-card orange" style="border:1px solid var(--border);">
        <div class="stat-label">Total Revenue</div>
        <div class="stat-value" style="font-size:22px;">${fmtCurrency(totalRevenue)}</div>
      </div>
      <div class="stat-card green" style="border:1px solid var(--border);">
        <div class="stat-label">Total Gross Profit</div>
        <div class="stat-value" style="font-size:22px;">${fmtCurrency(totalProfit)}</div>
      </div>
      <div class="stat-card blue" style="border:1px solid var(--border);">
        <div class="stat-label">Avg Profit Margin</div>
        <div class="stat-value" style="font-size:22px;">${fmt(avgMargin, 1)}%</div>
      </div>
    </div>

    <h3 style="font-size:13px;font-weight:700;color:var(--charcoal-mid);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px;">
      Profit by Item
    </h3>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${sorted.map(r => {
        const profitPct = totalProfit > 0 ? (parseFloat(r.total_gross_profit) / totalProfit) * 100 : 0;
        return `
          <div style="display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:12px;padding:10px 12px;background:#fff;border:1px solid var(--border);border-radius:8px;">
            <div>
              <div style="font-weight:600;font-size:13px;">${escHtml(r.item_name)}</div>
              <div style="font-size:11px;color:var(--charcoal-soft);">${escHtml(r.item_sku)}</div>
              <div class="margin-bar" style="margin-top:6px;">
                <div class="margin-track">
                  <div class="margin-fill" style="width:${profitPct.toFixed(1)}%;"></div>
                </div>
                <span class="margin-text">${fmt(profitPct, 1)}% of total</span>
              </div>
            </div>
            <div style="text-align:right;">
              <div class="money profit" style="font-size:15px;">${fmtCurrency(r.total_gross_profit)}</div>
              <div style="font-size:11px;color:var(--charcoal-soft);">profit</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:13px;font-weight:700;color:${parseFloat(r.profit_margin)>=50?'var(--green)':'var(--orange)'};">
                ${fmt(r.profit_margin, 1)}%
              </div>
              <div style="font-size:11px;color:var(--charcoal-soft);">margin</div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════════
// TABLE TABS
// ══════════════════════════════════════════════════════════════════════════

function setTableTab(tab) {
  state.currentTab = tab;
  document.getElementById('tab-inventory').classList.toggle('active', tab === 'inventory');
  document.getElementById('tab-analytics').classList.toggle('active', tab === 'analytics');
  document.getElementById('tab-inventory-btn').style.color = tab === 'inventory' ? 'var(--orange)' : '';
  document.getElementById('tab-inventory-btn').style.borderColor = tab === 'inventory' ? 'var(--orange)' : '';
  document.getElementById('tab-analytics-btn').style.color = tab === 'analytics' ? 'var(--orange)' : '';
  document.getElementById('tab-analytics-btn').style.borderColor = tab === 'analytics' ? 'var(--orange)' : '';
  if (tab === 'analytics') renderAnalytics(state.liveData);
}

// ══════════════════════════════════════════════════════════════════════════
// MODAL
// ══════════════════════════════════════════════════════════════════════════

function openHistoryModal() {
  document.getElementById('history-modal').classList.add('open');
  fetchHistory();
  document.body.style.overflow = 'hidden';
}

function closeHistoryModal() {
  document.getElementById('history-modal').classList.remove('open');
  document.body.style.overflow = '';
}

// Close on overlay click
document.getElementById('history-modal').addEventListener('click', function (e) {
  if (e.target === this) closeHistoryModal();
});

// Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeHistoryModal();
});

// ══════════════════════════════════════════════════════════════════════════
// SEARCH FILTERS
// ══════════════════════════════════════════════════════════════════════════

document.getElementById('table-search').addEventListener('input', () => {
  renderLiveTable(state.liveData);
});

document.getElementById('history-search').addEventListener('input', () => {
  renderHistoryTable(state.historyData);
});

// ══════════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════════

document.getElementById('action_type').addEventListener('change', onActionTypeChange);

document.getElementById('bridal_status').addEventListener('change', function () {
  const rentalFields = document.getElementById('rental-fields');
  if (this.value === 'Rented') {
    rentalFields.classList.remove('hidden');
  } else {
    rentalFields.classList.add('hidden');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// BADGE HELPERS
// ══════════════════════════════════════════════════════════════════════════

function getBridalStatusBadge(status, overdue = false) {
  if (!status) return '<span class="muted">—</span>';
  if (overdue) return `<span class="badge badge-overdue">⚠️ ${escHtml(status)}</span>`;
  const map = {
    'Available':    'badge-available',
    'Rented':       'badge-rented',
    'In Alteration':'badge-alteration',
    'Dry Cleaning': 'badge-cleaning',
    'Sold':         'badge-sold',
  };
  return `<span class="badge ${map[status] || ''}">${escHtml(status)}</span>`;
}

function getActionBadge(action) {
  const map = {
    'New Item':      ['badge-new',    '✨'],
    'Restock':       ['badge-restock','📦'],
    'Retail Sale':   ['badge-sale',   '🛒'],
    'Rental Out':    ['badge-rented', '🎁'],
    'Rental Return': ['badge-return', '↩️'],
    'Status Change': ['badge-status', '🔄'],
  };
  const [cls, icon] = map[action] || ['', '•'];
  return `<span class="badge ${cls}">${icon} ${escHtml(action)}</span>`;
}

// ══════════════════════════════════════════════════════════════════════════
// COLOR HELPER
// ══════════════════════════════════════════════════════════════════════════

function getColorHex(colorName) {
  const map = {
    black: '#1A1A1A', white: '#F5F5F5', red: '#DC2626', blue: '#2563EB',
    green: '#16A34A', yellow: '#CA8A04', pink: '#EC4899', purple: '#7C3AED',
    brown: '#92400E', tan: '#D97706', navy: '#1E3A5F', grey: '#6B7280',
    gray: '#6B7280', beige: '#D4B483', gold: '#F59E0B', silver: '#94A3B8',
    orange: '#FF7A00', cream: '#FEFCE8', nude: '#E8C9A0', camel: '#C19A6B',
  };
  const key = colorName?.toLowerCase().replace(/\s/g,'');
  return map[key] || '#999';
}

// ══════════════════════════════════════════════════════════════════════════
// SKU AUTOCOMPLETE
// ══════════════════════════════════════════════════════════════════════════

function updateSkuSuggestions() {
  const dl = document.getElementById('sku-suggestions');
  const shopSkus = state.liveData
    .filter(r => r.shop_type === state.currentShop)
    .map(r => r.item_sku);
  dl.innerHTML = shopSkus.map(s => `<option value="${escHtml(s)}">`).join('');
}

// Auto-fill item name when SKU is entered
document.getElementById('item_sku').addEventListener('change', function () {
  const sku = this.value.trim().toUpperCase();
  const match = state.liveData.find(r => r.item_sku === sku);
  if (match) {
    document.getElementById('item_name').value      = match.item_name;
    document.getElementById('brand_designer').value = match.brand_designer || '';
    if (state.currentShop === 'Bags') {
      document.getElementById('bag_color').value     = match.bag_color || '';
      document.getElementById('min_stock_alert').value = match.min_stock_alert || 2;
    } else {
      document.getElementById('bridal_size').value   = match.bridal_size || '';
    }
    showToast(`Auto-filled details for ${sku}`, 'info');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════

(async function init() {
  // Set defaults
  document.getElementById('shop_type_field').value = 'Bags';
  updateActionTypeOptions('Bags');

  // Load data
  await fetchLiveInventory();

  // Auto-refresh every 60 seconds
  setInterval(fetchLiveInventory, 60000);
})();
