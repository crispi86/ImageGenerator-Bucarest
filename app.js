// ── State ─────────────────────────────────────────────────────────────────────
let collectionsData   = [];
let productsData      = [];
let currentCollection = null;
const productStates   = {};
const generationLog   = [];
let marketingResultBase64    = null;
let allProductsData          = [];
let allProductsLoaded        = false;
let selectedMarketingProduct = null; // { id, title, image }

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadCollections();
  loadStats();
  document.addEventListener('click', e => {
    if (!e.target.closest('.mkt-autocomplete')) {
      const dd = document.getElementById('mkt-dropdown');
      if (dd) dd.style.display = 'none';
    }
  });
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'marketing' && !allProductsLoaded) loadAllProducts();
}

// ── Collections ───────────────────────────────────────────────────────────────
async function loadCollections() {
  try {
    const data = await api('/api/collections');
    collectionsData = data.collections;
    const sel = document.getElementById('collection-select');
    if (!collectionsData.length) {
      sel.innerHTML = '<option value="">No se encontraron colecciones</option>';
      return;
    }
    sel.innerHTML = '<option value="">— Selecciona una colección —</option>' +
      collectionsData.map(c => `<option value="${c.id}">${c.title}</option>`).join('');
  } catch (e) {
    showToast('Error cargando colecciones: ' + e.message, true);
  }
}

function onCollectionChange() {
  const val = document.getElementById('collection-select').value;
  document.getElementById('btn-load').disabled = !val;
}

async function loadProducts() {
  const collectionId = document.getElementById('collection-select').value;
  if (!collectionId) return;

  currentCollection = collectionsData.find(c => String(c.id) === String(collectionId));
  const btn = document.getElementById('btn-load');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Cargando...';

  try {
    const data = await api(`/api/products?collectionId=${collectionId}`);
    productsData = data.products;
    renderProducts(productsData);
    document.getElementById('batch-bar').style.display  = productsData.length ? 'flex'  : 'none';
    document.getElementById('hint-card').style.display  = productsData.length ? 'flex'  : 'none';
    document.getElementById('catalog-prompt-hint').value = '';
  } catch (e) {
    showToast('Error cargando productos: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Cargar productos';
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderProducts(products) {
  const container = document.getElementById('products-container');
  if (!products.length) {
    container.innerHTML = '<div class="empty-state">No se encontraron productos en esta colección</div>';
    return;
  }
  container.innerHTML = '<div class="products-grid" id="products-grid">' +
    products.map(p => renderCard(p)).join('') + '</div>';
  updateBatchControls();
  applyFilters();
}

function applyFilters() {
  const statusVal = document.getElementById('filter-status')?.value || '';
  const stockVal  = document.getElementById('filter-stock')?.value  || '';
  const hideAi    = document.getElementById('hide-generated')?.checked || false;

  document.querySelectorAll('.product-card').forEach(card => {
    const id      = card.dataset.id;
    const product = productsData.find(p => String(p.id) === String(id));
    if (!product) return;

    const passStatus = !statusVal || product.status === statusVal;
    const passStock  = !stockVal  || (stockVal === 'available' ? product.available : !product.available);
    const passAi     = !hideAi   || !product.hasGeneratedImage;

    card.style.display = (passStatus && passStock && passAi) ? '' : 'none';
  });
}

function renderCard(p) {
  const imgHtml = p.image
    ? `<img src="${p.image}" alt="${escHtml(p.title)}" loading="lazy">`
    : `<div class="card-img-placeholder">🖼</div>`;

  const aiBadge = p.hasGeneratedImage
    ? `<div class="ai-badge" title="Ya tiene imagen IA aprobada">&#10003; IA aprobada</div>`
    : '';

  const statusBadge = p.status === 'draft'
    ? `<div class="draft-badge">Borrador</div>`
    : '';

  const stockBadge = !p.available
    ? `<div class="nostock-badge">Sin stock</div>`
    : '';

  return `<div class="product-card${p.hasGeneratedImage ? ' has-ai' : ''}" id="card-${p.id}" data-id="${p.id}" data-has-ai="${p.hasGeneratedImage ? '1' : '0'}">
  <div class="card-select">
    <input type="checkbox" class="p-check" data-id="${p.id}" onchange="onCheckboxChange()">
  </div>
  ${aiBadge}${statusBadge}${stockBadge}
  <div class="card-img-wrap">${imgHtml}</div>
  <div class="card-body">
    <div class="card-title">${escHtml(p.title)}</div>
    <div class="card-meta">${p.imageCount} imagen${p.imageCount !== 1 ? 'es' : ''} actuales</div>
    <div class="card-actions">
      <span class="status-badge badge-idle" id="badge-${p.id}">Sin generar</span>
      <button class="btn btn-secondary btn-sm" id="btn-gen-${p.id}" onclick="generateSingle('${p.id}', this)">
        Generar
      </button>
    </div>
  </div>
  <div class="card-preview" id="preview-${p.id}" style="display:none">
    <div class="generated-img-wrap">
      <img id="gen-img-${p.id}" src="" alt="Imagen generada">
    </div>
    <div class="preview-actions">
      <button class="btn btn-approve" onclick="approveImage('${p.id}')">✓ Aprobar</button>
      <button class="btn btn-reject" onclick="rejectImage('${p.id}')">✗ Rechazar</button>
    </div>
    <div class="prompt-editor">
      <label>Prompt — edita y regenera si es necesario</label>
      <textarea id="prompt-edit-${p.id}" placeholder="El prompt aparecerá aquí tras generar..."></textarea>
      <div class="prompt-editor-actions">
        <button class="btn btn-secondary btn-xs" onclick="regenerateWithPrompt('${p.id}', this)">↺ Regenerar con este prompt</button>
      </div>
    </div>
  </div>
</div>`;
}

// ── Generate single ───────────────────────────────────────────────────────────
async function generateSingle(productId, btn, customPrompt = null) {
  const product = productsData.find(p => String(p.id) === String(productId));
  if (!product) return;

  setCardState(productId, 'generating');
  if (btn) btn.disabled = true;

  try {
    const hint = document.getElementById('catalog-prompt-hint')?.value.trim();
    const body = {
      productId,
      productTitle: product.title,
      collectionTitle: currentCollection.title,
      productImageUrl: product.image,
    };
    if (customPrompt) body.customPrompt = customPrompt;
    if (hint && !customPrompt) body.promptHint = hint;

    const data = await api('/api/generate', 'POST', body);
    productStates[productId] = { imageUrl: data.imageUrl, prompt: data.prompt };
    setCardState(productId, 'preview');
    document.getElementById('gen-img-' + productId).src = data.imageUrl;
    document.getElementById('preview-' + productId).style.display = 'block';
    const promptEdit = document.getElementById('prompt-edit-' + productId);
    if (promptEdit) promptEdit.value = data.prompt;
    loadStats();
    addLogEntry(productId, product.title, data.imageUrl, data.prompt, 'generated');
  } catch (e) {
    setCardState(productId, 'error');
    showToast('Error: ' + e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function regenerateWithPrompt(productId, btn) {
  const textarea = document.getElementById('prompt-edit-' + productId);
  const customPrompt = textarea?.value?.trim();
  if (!customPrompt) return;
  const genBtn = document.getElementById('btn-gen-' + productId);
  if (btn) btn.disabled = true;
  try {
    await generateSingle(productId, genBtn, customPrompt);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Batch generate ────────────────────────────────────────────────────────────
async function generateBatch() {
  const selected = getSelectedIds();
  if (!selected.length) { showToast('Selecciona al menos un producto', true); return; }
  if (!currentCollection) { showToast('Carga una colección primero', true); return; }

  const btn = document.getElementById('btn-batch');
  btn.disabled = true;

  const progressWrap = document.getElementById('progress-wrap');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  progressWrap.style.display = 'block';

  let done = 0;
  const total = selected.length;

  try {
    for (const id of selected) {
      const product = productsData.find(p => String(p.id) === String(id));
      if (!product) { done++; continue; }

      progressFill.style.width = Math.round((done / total) * 100) + '%';
      progressText.textContent = `${done + 1} / ${total} — ${product.title}`;

      await generateSingle(id, null);
      done++;
      progressFill.style.width = Math.round((done / total) * 100) + '%';
    }
    progressFill.style.width = '100%';
    progressText.textContent = 'Lote completado. Revisa las imágenes generadas.';
  } finally {
    btn.disabled = false;
    setTimeout(() => { progressWrap.style.display = 'none'; }, 3000);
    loadStats();
  }
}


// ── Approve / Reject ──────────────────────────────────────────────────────────
async function approveImage(productId) {
  const state = productStates[productId];
  if (!state) return;

  const product = productsData.find(p => String(p.id) === String(productId));
  const btn = document.querySelector(`#card-${productId} .btn-approve`);
  if (btn) { btn.disabled = true; btn.textContent = '↑ Subiendo...'; }

  try {
    await api('/api/approve', 'POST', {
      productId,
      productTitle: product?.title || '',
    });
    setCardState(productId, 'approved');
    document.getElementById('preview-' + productId).style.display = 'none';
    updateLogEntry(productId, state.imageUrl, 'approved');
    showToast('✓ Imagen subida a Shopify');
    loadStats();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Aprobar'; }
    showToast('Error al subir: ' + e.message, true);
  }
}

async function rejectImage(productId) {
  const state = productStates[productId];
  await api('/api/reject', 'POST', { productId });
  updateLogEntry(productId, state?.imageUrl, 'rejected');
  setCardState(productId, 'rejected');
  document.getElementById('preview-' + productId).style.display = 'none';
  delete productStates[productId];
  setTimeout(() => setCardState(productId, 'idle'), 1500);
  loadStats();
}

// ── Card state ────────────────────────────────────────────────────────────────
function setCardState(productId, state) {
  const badge = document.getElementById('badge-' + productId);
  const btn   = document.getElementById('btn-gen-' + productId);
  if (!badge) return;

  badge.className = 'status-badge';
  switch (state) {
    case 'generating':
      badge.classList.add('badge-generating');
      badge.innerHTML = '<span class="spinner"></span> Generando...';
      if (btn) btn.disabled = true;
      break;
    case 'preview':
      badge.classList.add('badge-preview');
      badge.textContent = 'Pendiente revisión';
      if (btn) btn.disabled = false;
      break;
    case 'approved':
      badge.classList.add('badge-approved');
      badge.textContent = '✓ Aprobada';
      if (btn) btn.disabled = false;
      break;
    case 'rejected':
      badge.classList.add('badge-rejected');
      badge.textContent = '✗ Rechazada';
      if (btn) btn.disabled = false;
      break;
    case 'error':
      badge.classList.add('badge-error');
      badge.textContent = 'Error';
      if (btn) btn.disabled = false;
      break;
    default:
      badge.classList.add('badge-idle');
      badge.textContent = 'Sin generar';
      if (btn) btn.disabled = false;
  }
}

// ── Batch controls ────────────────────────────────────────────────────────────
function onCheckboxChange() { updateBatchControls(); }

function toggleSelectAll(chk) {
  document.querySelectorAll('.p-check').forEach(c => c.checked = chk.checked);
  updateBatchControls();
}

function selectWithoutGenerated() {
  document.querySelectorAll('.p-check').forEach(c => {
    const card = document.getElementById('card-' + c.dataset.id);
    c.checked = card && card.dataset.hasAi !== '1';
  });
  document.getElementById('select-all').checked = false;
  updateBatchControls();
}

function toggleHideGenerated() { applyFilters(); }

function updateBatchControls() {
  const selected = getSelectedIds();
  const btn = document.getElementById('btn-batch');
  if (selected.length > 0) {
    btn.disabled = false;
    btn.textContent = `Generar seleccionados (${selected.length})`;
  } else {
    btn.disabled = true;
    btn.textContent = 'Generar seleccionados';
  }
}

function getSelectedIds() {
  return [...document.querySelectorAll('.p-check:checked')].map(c => c.dataset.id);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const data = await api('/api/stats');
    document.getElementById('stat-generated').textContent = data.generated + ' generadas';
    document.getElementById('stat-approved').textContent  = data.approved + ' aprobadas';
  } catch {}
}

// ── Log ───────────────────────────────────────────────────────────────────────
function addLogEntry(productId, title, imageUrl, prompt, status) {
  generationLog.push({ productId, title, imageUrl, prompt, status, ts: new Date().toISOString() });
  renderLogSection();
}

function updateLogEntry(productId, imageUrl, status) {
  const entry = generationLog.find(e => String(e.productId) === String(productId) && e.imageUrl === imageUrl);
  if (entry) entry.status = status;
  renderLogSection();
}

function renderLogSection() {
  const sec  = document.getElementById('log-section');
  const wrap = document.getElementById('log-entries');
  sec.style.display = 'block';
  wrap.innerHTML = generationLog.slice().reverse().map(e =>
    `<div class="log-entry">
      <span class="status-badge ${e.status === 'approved' ? 'badge-approved' : e.status === 'rejected' ? 'badge-rejected' : 'badge-preview'}">${e.status}</span>
      <span style="flex:1;font-size:12px">${escHtml(e.title)}</span>
      <span style="color:#9a8a7a;font-size:11px">${e.ts.slice(11,16)}</span>
    </div>`
  ).join('');
}

function exportLog() {
  if (!generationLog.length) { showToast('No hay datos para exportar'); return; }
  const rows = generationLog.map(e =>
    `"${e.productId}","${e.title.replace(/"/g,'""')}","${e.status}","${e.ts}","${e.imageUrl || ''}"`
  );
  const csv  = 'ID,Título,Estado,Fecha,URL Imagen\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'bucarest-images-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click(); URL.revokeObjectURL(url);
}

// ── Marketing tab ─────────────────────────────────────────────────────────────
async function loadAllProducts() {
  const inp = document.getElementById('mkt-search');
  if (inp) inp.placeholder = 'Cargando productos...';
  try {
    const data = await api('/api/all-products');
    allProductsData   = data.products;
    allProductsLoaded = true;
    if (inp) inp.placeholder = `Buscar entre ${allProductsData.length} productos...`;
  } catch (e) {
    if (inp) inp.placeholder = 'Error al cargar — recarga la página';
    showToast('Error cargando productos: ' + e.message, true);
  }
}

function filterMarketingProducts() {
  const query = document.getElementById('mkt-search').value.trim();
  const dd    = document.getElementById('mkt-dropdown');
  if (!query || query.length < 2) { dd.style.display = 'none'; return; }

  const q        = query.toLowerCase();
  const filtered = allProductsData.filter(p => p.title.toLowerCase().includes(q)).slice(0, 20);

  if (!filtered.length) {
    dd.innerHTML = '<div class="mkt-dropdown-empty">Sin resultados</div>';
  } else {
    dd.innerHTML = filtered.map(p =>
      `<div class="mkt-dropdown-item"
        data-id="${escHtml(String(p.id))}"
        data-title="${escHtml(p.title)}"
        data-image="${escHtml(p.image || '')}"
        onclick="selectMarketingProduct(this)">${escHtml(p.title)}</div>`
    ).join('');
  }
  dd.style.display = 'block';
}

function selectMarketingProduct(el) {
  selectedMarketingProduct = {
    id:    el.dataset.id,
    title: el.dataset.title,
    image: el.dataset.image,
  };
  document.getElementById('mkt-search').value   = selectedMarketingProduct.title;
  document.getElementById('mkt-dropdown').style.display = 'none';

  const chip = document.getElementById('mkt-selected-chip');
  document.getElementById('mkt-chip-img').src          = selectedMarketingProduct.image;
  document.getElementById('mkt-chip-name').textContent = selectedMarketingProduct.title;
  chip.style.display = 'flex';

  const wrap = document.getElementById('mkt-thumb-wrap');
  wrap.innerHTML = selectedMarketingProduct.image
    ? `<img class="mkt-product-thumb" src="${escHtml(selectedMarketingProduct.image)}" alt="">`
    : `<div class="mkt-product-thumb-empty">🖼</div>`;

  document.getElementById('btn-mkt-generate').disabled = false;
  document.getElementById('mkt-result').style.display  = 'none';
}

function clearMarketingProduct() {
  selectedMarketingProduct = null;
  document.getElementById('mkt-search').value          = '';
  document.getElementById('mkt-selected-chip').style.display = 'none';
  document.getElementById('mkt-thumb-wrap').innerHTML  = '<div class="mkt-product-thumb-empty">🖼</div>';
  document.getElementById('btn-mkt-generate').disabled = true;
  document.getElementById('mkt-result').style.display  = 'none';
}

async function suggestMarketingPrompt() {
  if (!selectedMarketingProduct) {
    showToast('Selecciona un producto primero', true);
    return;
  }
  const btn = document.getElementById('btn-suggest');
  btn.disabled    = true;
  btn.textContent = '⌛';
  try {
    const data = await api('/api/suggest-prompt', 'POST', {
      productTitle:    selectedMarketingProduct.title,
      collectionTitle: 'General',
      productId:       selectedMarketingProduct.id,
    });
    document.getElementById('mkt-prompt').value = data.prompt;
  } catch (e) {
    showToast('Error: ' + e.message, true);
  } finally {
    btn.disabled    = false;
    btn.textContent = '✨ Sugerir con IA';
  }
}

async function generateMarketing() {
  if (!selectedMarketingProduct?.image) { showToast('Selecciona un producto primero', true); return; }
  const prompt      = document.getElementById('mkt-prompt').value.trim();
  const overlayText = document.getElementById('mkt-overlay-text').value.trim();
  if (!prompt) { showToast('Escribe un prompt para la imagen', true); return; }

  const btn = document.getElementById('btn-mkt-generate');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generando...';

  try {
    const data = await api('/api/generate-marketing', 'POST', {
      productImageUrl: selectedMarketingProduct.image,
      prompt,
      overlayText: overlayText || null,
    });
    marketingResultBase64 = data.imageBase64;
    document.getElementById('mkt-result-img').src = 'data:image/png;base64,' + data.imageBase64;
    document.getElementById('mkt-result').style.display = 'block';
    loadStats();
  } catch (e) {
    showToast('Error: ' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generar imagen';
  }
}

function downloadMarketingImage() {
  if (!marketingResultBase64) return;
  const name = selectedMarketingProduct?.title || 'marketing';
  const filename = 'bucarest-mkt-' + name.toLowerCase().replace(/\s+/g, '-').slice(0, 30) + '-' + Date.now() + '.png';
  const a = document.createElement('a');
  a.href = 'data:image/png;base64,' + marketingResultBase64;
  a.download = filename;
  a.click();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || resp.statusText);
  return data;
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer;
function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = isError ? '#c0392b' : '#2c4a3e';
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}
