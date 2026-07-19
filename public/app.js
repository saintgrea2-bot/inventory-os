/* =====================================================================
   InventoryOS — Frontend Application Logic (Redesigned)
   Dual-Shop: Ladies Bag Shop + Bridal Shop
   ===================================================================== */

'use strict';

const state = {
  currentView: 'dashboard',
  bridalTab: 'sales',
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
function fmtCurrency(num) { const n = parseFloat(num); return isNaN(n) ? '—' : 'ETB ' + fmt(n); }
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
  ['dashboard', 'bags', 'bridal'].forEach(v => {
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
  const available = bridal.filter(r => !r.bridal_status || r.bridal_status === 'Available').length;
  const rented = bridal.filter(r => r.bridal_status === 'Rented').length;
  document.getElementById('bridal-stats').innerHTML = `
    ${statCard('Items', bridal.length, 'orange')}
    ${statCard('Available', available, 'green')}
    ${statCard('Rented', rented, 'red')}
    ${statCard('Stock (owned)', stock, 'blue')}
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
        <td><div class="item-cell">${imgThumb(r,38)}<strong>${escHtml(r.item_name)}</strong></div></td>
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
        <td><div class="item-cell">${imgThumb(r,38)}<strong>${escHtml(r.item_name)}</strong></div></td>
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
        <div class="rental-item-head">${imgThumb(r,44)}<span class="rental-name">${escHtml(r.item_name)}</span></div>
        ${getBridalStatusBadge(r.bridal_status, overdue)}
      </div>
      <div class="rental-meta"><strong>${escHtml(r.item_sku)}</strong>${(r.rental_quantity && r.rental_quantity > 1) ? ` · ×${r.rental_quantity}` : ''}${r.bridal_size ? ` · Size ${escHtml(r.bridal_size)}` : ''}${r.brand_designer ? ` · ${escHtml(r.brand_designer)}` : ''}</div>
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
  currentItemImage = null;
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

// ══════════════════════════════════════════════════════════════════════════
// PRODUCT IMAGE (browse / capture / URL)
// ══════════════════════════════════════════════════════════════════════════

let currentItemImage = null;

function imageField() {
  return `<div class="form-group">
    <label class="form-label">Product Image</label>
    <div class="image-field">
      <div class="image-methods">
        <button type="button" class="image-method active" onclick="setImageMethod(this,'browse')">📁 Browse</button>
        <button type="button" class="image-method" onclick="setImageMethod(this,'capture')">📷 Capture</button>
        <button type="button" class="image-method" onclick="setImageMethod(this,'url')">🔗 URL</button>
      </div>
      <div class="image-inputs">
        <input type="file" id="f_img_browse" accept="image/*" style="display:none" onchange="onImagePick(event)">
        <input type="file" id="f_img_capture" accept="image/*" capture="environment" style="display:none" onchange="onImagePick(event)">
        <input type="url" class="form-input" id="f_img_url" placeholder="https://example.com/image.jpg" oninput="onImageUrlInput(event)" style="display:none">
        <button type="button" class="btn-secondary btn-sm" id="f_img_pickbtn" onclick="document.getElementById('f_img_browse').click()"><i class="ri-upload-2-line"></i> Choose file…</button>
      </div>
      <div class="image-preview" id="f_img_preview"></div>
      <div class="form-hint">Optional. Browse a file, take a photo, or paste an image URL.</div>
    </div>
  </div>`;
}

function setImageMethod(btn, method) {
  document.querySelectorAll('.image-method').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const browse = document.getElementById('f_img_browse');
  const capture = document.getElementById('f_img_capture');
  const url = document.getElementById('f_img_url');
  const pickbtn = document.getElementById('f_img_pickbtn');
  if (!pickbtn) return;
  url.style.display = 'none'; pickbtn.style.display = 'none';
  if (method === 'browse') { pickbtn.style.display = ''; pickbtn.innerHTML = '<i class="ri-upload-2-line"></i> Choose file…'; pickbtn.onclick = () => browse.click(); }
  else if (method === 'capture') { pickbtn.style.display = ''; pickbtn.innerHTML = '<i class="ri-camera-line"></i> Take photo'; pickbtn.onclick = () => capture.click(); }
  else if (method === 'url') { url.style.display = ''; }
}

async function onImagePick(event) {
  const file = event.target.files[0]; if (!file) return;
  try {
    const dataUrl = await fileToResizedDataUrl(file, 800, 0.8);
    currentItemImage = dataUrl;
    showImagePreview(dataUrl);
  } catch (e) { showToast('Could not read image: ' + e.message, 'error'); }
  event.target.value = '';
}

function onImageUrlInput(event) {
  const url = event.target.value.trim();
  if (url) { currentItemImage = url; showImagePreview(url); }
  else { currentItemImage = null; const pv = document.getElementById('f_img_preview'); if (pv) pv.innerHTML = ''; }
}

function showImagePreview(src) {
  const pv = document.getElementById('f_img_preview'); if (!pv) return;
  pv.innerHTML = `<img src="${escHtml(src)}" alt="preview"><button type="button" class="image-clear" onclick="clearImage()">✕ Remove</button>`;
}

function clearImage() {
  currentItemImage = null;
  const pv = document.getElementById('f_img_preview'); if (pv) pv.innerHTML = '';
  const url = document.getElementById('f_img_url'); if (url) url.value = '';
}

function fileToResizedDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > width && height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        else if (width > maxDim) { width = maxDim; height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function imgThumb(r, size) {
  if (!r || !r.item_image) return '';
  return `<img class="img-thumb" src="${escHtml(r.item_image)}" alt="${escHtml(r.item_name || '')}" style="width:${size}px;height:${size}px;" loading="lazy" onerror="this.style.display='none'">`;
}

function buildActionForm(action, shop, presetSku) {
  const items = shopItems(shop);

  if (action === 'new_item') {
    if (shop === 'Bags') {
      return formWrap(`
        ${field('SKU *', input('f_sku', 'text', 'placeholder="BAG-001" required'))}
        ${field('Item Name *', input('f_name', 'text', 'placeholder="Classic Leather Tote" required'))}
        ${row(field('Brand', input('f_brand', 'text', 'placeholder="Gucci"')), field('Color', input('f_color', 'text', 'placeholder="Black"')))}
        ${row(field('Cost Price *', input('f_cost', 'number', 'placeholder="0.00" min="0" step="0.01" required')), field('Sell Price', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')))}
        ${row(field('Quantity *', input('f_qty', 'number', 'placeholder="5" required')), field('Low Stock Alert', input('f_min', 'number', 'value="2" min="0"')))}
        ${imageField()}
        ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
      `);
    } else {
      return formWrap(`
        ${field('SKU *', input('f_sku', 'text', 'placeholder="GOWN-001" required'))}
        ${field('Gown/Item Name *', input('f_name', 'text', 'placeholder="Lace Mermaid Gown" required'))}
        ${row(field('Designer', input('f_brand', 'text', 'placeholder="Vera Wang"')), field('Size', input('f_size', 'text', 'placeholder="UK 10"')))}
        ${row(field('Cost Price *', input('f_cost', 'number', 'placeholder="0.00" min="0" step="0.01" required')), field('Sell/Rental Price', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')))}
        ${row(field('Quantity', input('f_qty', 'number', 'value="1"')), field('Status', select('f_status', statusOptions('Available'))))}
        ${imageField()}
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
    // Available items from bridal inventory only (rentals are Bridal-exclusive).
    // 'Returned' items are back in stock and rentable again.
    const available = items.filter(r => !r.bridal_status || r.bridal_status === 'Available' || r.bridal_status === 'Returned');
    return formWrap(`
      ${field('Select Available Item *', select('f_sku', productOptions(available)), 'Choose an available bridal item to rent out')}
      ${row(field('Customer Name & Contact *', input('f_customer', 'text', 'placeholder="Name — Phone / Email" required')), field('Return Due Date *', input('f_due', 'date', 'required')))}
      ${row(field('Rental Price', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')), field('Quantity', input('f_qty', 'number', 'value="1"')))}
      ${field('Notes', `<textarea class="form-textarea" id="f_notes"></textarea>`)}
    `);
  }

  if (action === 'return_rental') {
    const rented = items.filter(r => r.bridal_status === 'Rented');
    return formWrap(`
      ${field('Select Rented Item *', select('f_sku', productOptions(rented), false), 'Choose the item being returned — it goes back to Available stock')}
      ${row(field('Return Status', select('f_status', statusOptions('Available'))), field('Late Fee (optional)', input('f_sell', 'number', 'placeholder="0.00" min="0" step="0.01"')))}
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
      body.item_image = currentItemImage || null;
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
      body.quantity = parseInt(val('f_qty')) || 1;
      body.quantity_change = 0;
      body.customer_name_contact = val('f_customer') || null; body.rental_due_date = val('f_due') || null;
      body.notes = val('f_notes') || null;
    } else if (action === 'return_rental') {
      actionType = 'Rental Return';
      const item = itemsBySku(val('f_sku'), shop);
      body.item_sku = val('f_sku'); body.item_name = item?.item_name; body.brand_designer = item?.brand_designer || null;
      body.bridal_size = item?.bridal_size || null; body.bridal_status = val('f_status') || 'Available';
      body.stock_cost_price = 0; body.sell_price = val('f_sell') || 0; body.quantity_change = 0;
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
    item_image: r.item_image || '',
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
        item_image: row.item_image || '',
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
