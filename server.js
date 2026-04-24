require('dotenv').config();
const express  = require('express');
const https    = require('https');
const path     = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI   = require('openai');
const shopify  = require('./shopify');
const { getContext, getSizeDescription } = require('./collections');

const app  = express();
const PORT = process.env.PORT || 3003;

app.use(express.json({ limit: '50mb' }));

// ── Usage tracking ────────────────────────────────────────────────────────────
const DAILY_LIMIT = parseInt(process.env.DAILY_IMAGE_LIMIT) || 100;
let stats = { generated: 0, approved: 0, rejected: 0, costUSD: 0 };
const generationLog = [];

// ── AI clients ────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return next();
  res.status(401).json({ error: 'No autenticado. Visita /shopify/auth para conectar.' });
}

app.get('/shopify/auth', (req, res) => {
  const shop   = (process.env.SHOPIFY_SHOP || '').trim();
  const key    = (process.env.SHOPIFY_API_KEY || '').trim();
  const appUrl = (process.env.APP_URL || '').trim();
  const scopes = 'read_products,write_products,read_content';
  const redirect = encodeURIComponent(`${appUrl}/shopify/callback`);
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${key}&scope=${scopes}&redirect_uri=${redirect}`);
});

app.get('/shopify/callback', async (req, res) => {
  const { code } = req.query;
  const shop      = (process.env.SHOPIFY_SHOP || '').trim();
  const key       = (process.env.SHOPIFY_API_KEY || '').trim();
  const secret    = (process.env.SHOPIFY_API_SECRET || '').trim();
  try {
    const tokenRes = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ client_id: key, client_secret: secret, code });
      const opts = {
        hostname: shop, path: '/admin/oauth/access_token', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const r = https.request(opts, resp => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => resolve(JSON.parse(d)));
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
    const token = tokenRes.access_token;
    process.env.SHOPIFY_ACCESS_TOKEN = token;
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
      <h2>✅ Conectado a Shopify</h2>
      <p>Copia este token y agrégalo como variable de entorno <strong>SHOPIFY_ACCESS_TOKEN</strong> en Railway:</p>
      <code style="display:block;padding:16px;background:#f4f4f4;border-radius:6px;word-break:break-all">${token}</code>
      <p style="margin-top:24px"><a href="/admin" style="background:#2c4a3e;color:white;padding:12px 24px;border-radius:6px;text-decoration:none">Ir a la app →</a></p>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send('Error en OAuth: ' + e.message);
  }
});

// ── In-memory image store ─────────────────────────────────────────────────────
const generatedImages = {}; // { productId: base64 }

// ── Core AI logic ─────────────────────────────────────────────────────────────
async function buildBackgroundPrompt(productTitle, collectionTitle, metafields) {
  const context  = getContext(collectionTitle, productTitle, metafields);
  const sizeDesc = getSizeDescription(metafields.alto, metafields.ancho, collectionTitle);

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Write a DALL-E 3 prompt for an empty interior scene. A "${productTitle}" (${collectionTitle}) will be composited into it afterwards, so the scene must have a clear, unobstructed placement area where this type of object naturally belongs.

Context: ${context}
${sizeDesc ? `The object is a ${sizeDesc}` : ''}

Requirements:
- Empty scene — NO object in the placement area, leave it visually open and ready
- Warm natural light from the side
- Neutral contemporary aspirational atmosphere
- Colors: warm whites, soft grays, natural wood tones
- No people, no clutter
- Photorealistic editorial interior photography
- 100 words max, start directly with the scene description`,
    }],
  });

  return msg.content[0].text.trim();
}

async function removeBackground(imageBuffer) {
  if (!process.env.REMOVE_BG_API_KEY) throw new Error('REMOVE_BG_API_KEY no configurada.');
  const boundary = 'FormBoundary' + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image_file"; filename="product.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    imageBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.remove.bg',
      path:     '/v1.0/removebg',
      method:   'POST',
      headers: {
        'X-Api-Key':    process.env.REMOVE_BG_API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 200) resolve(buf);
        else reject(new Error('remove.bg: ' + buf.toString().slice(0, 200)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function generateBackground(prompt) {
  const response = await getOpenAI().images.generate({
    model:   'dall-e-3',
    prompt,
    size:    '1024x1024',
    quality: 'standard',
    n:       1,
  });
  return shopify.downloadImageBuffer(response.data[0].url);
}

function buildOverlaySVG(metafields) {
  const parts = [];
  if (metafields.alto)        parts.push(`Alto: ${metafields.alto} cm`);
  if (metafields.ancho)       parts.push(`Ancho: ${metafields.ancho} cm`);
  if (metafields.profundidad) parts.push(`Prof.: ${metafields.profundidad} cm`);
  const dimLine = parts.join('   |   ');

  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  return `<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.62"/>
    </linearGradient>
  </defs>
  <rect x="0" y="800" width="1024" height="224" fill="url(#g)"/>
  ${dimLine ? `<text x="512" y="882" font-family="Georgia, 'Times New Roman', serif" font-size="20" fill="white" text-anchor="middle" letter-spacing="2">${esc(dimLine)}</text>` : ''}
  <text x="512" y="924" font-family="Georgia, 'Times New Roman', serif" font-size="14" fill="rgba(255,255,255,0.88)" text-anchor="middle">Interpretación realizada con IA — La pieza puede presentar leves diferencias</text>
  <text x="512" y="950" font-family="Georgia, 'Times New Roman', serif" font-size="13" fill="rgba(255,255,255,0.68)" text-anchor="middle">Para más detalle, ver fotos anteriores</text>
</svg>`;
}

async function compositeImages(bgBuffer, productPngBuffer, collectionTitle, metafields) {
  const sharp = require('sharp');
  const BG    = 1024;

  const wallArt = ['Chilena contemporánea','Chilena clásica','Europea clásica','Extranjera contemporánea','Religiosa','Alfombras y tapicerías','Espejos'];
  const isWall  = wallArt.includes(collectionTitle);

  const sizeDesc  = getSizeDescription(metafields.alto, metafields.ancho, collectionTitle);
  const factor    = sizeDesc?.includes('large') ? 0.62 : sizeDesc?.includes('small') ? 0.28 : 0.48;
  const maxDim    = Math.round(BG * factor);

  const meta      = await sharp(productPngBuffer).metadata();
  const resizeOpt = meta.width >= meta.height ? { width: maxDim } : { height: maxDim };
  const resized   = await sharp(productPngBuffer).resize(resizeOpt).png().toBuffer();
  const gravity   = isWall ? 'centre' : 'south';
  const overlaySvg = Buffer.from(buildOverlaySVG(metafields));

  const result = await sharp(bgBuffer)
    .resize(BG, BG)
    .composite([
      { input: resized,     gravity },
      { input: overlaySvg, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();

  return result.toString('base64');
}

// ── API routes ────────────────────────────────────────────────────────────────
app.get('/api/collections', requireAuth, async (req, res) => {
  try {
    const collections = await shopify.getTargetCollections();
    res.json({ collections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products', requireAuth, async (req, res) => {
  const { collectionId } = req.query;
  if (!collectionId) return res.status(400).json({ error: 'collectionId requerido' });
  try {
    const products = await shopify.getProductsByCollection(collectionId);
    res.json({ products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate', requireAuth, async (req, res) => {
  const { productId, productTitle, collectionTitle, productImageUrl } = req.body;
  if (!productId || !productTitle || !collectionTitle)
    return res.status(400).json({ error: 'Faltan parámetros' });
  if (!productImageUrl)
    return res.status(400).json({ error: 'Este producto no tiene imagen. Agrega una foto en Shopify primero.' });
  if (stats.generated >= DAILY_LIMIT)
    return res.status(429).json({ error: `Límite diario de ${DAILY_LIMIT} imágenes alcanzado.` });
  if (!process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: 'OpenAI API key no configurada.' });

  try {
    const metafields    = await shopify.getProductMetafields(productId);
    const bgPrompt      = await buildBackgroundPrompt(productTitle, collectionTitle, metafields);
    const productBuffer = await shopify.downloadImageBuffer(productImageUrl);
    const [noBgBuffer, bgBuffer] = await Promise.all([
      removeBackground(productBuffer),
      generateBackground(bgPrompt),
    ]);
    const base64 = await compositeImages(bgBuffer, noBgBuffer, collectionTitle, metafields);

    generatedImages[productId] = base64;
    stats.generated++;
    stats.costUSD = Math.round((stats.costUSD + 0.06) * 100) / 100;

    generationLog.push({
      productId, productTitle, collectionTitle, prompt: bgPrompt, status: 'generated', ts: new Date().toISOString(),
    });

    res.json({ imageUrl: `/api/generated-image/${productId}`, prompt: bgPrompt, cost: 0.06 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/generated-image/:productId', requireAuth, (req, res) => {
  const base64 = generatedImages[req.params.productId];
  if (!base64) return res.status(404).send('No encontrada');
  res.setHeader('Content-Type', 'image/png');
  res.send(Buffer.from(base64, 'base64'));
});

app.post('/api/generate-batch', requireAuth, async (req, res) => {
  const { products, collectionTitle } = req.body;
  if (!products?.length) return res.status(400).json({ error: 'Sin productos' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = data => res.write('data: ' + JSON.stringify(data) + '\n\n');

  const remaining = DAILY_LIMIT - stats.generated;
  const toProcess = products.slice(0, remaining);

  send({ type: 'total', total: toProcess.length });

  for (let i = 0; i < toProcess.length; i++) {
    const { productId, productTitle, productImageUrl } = toProcess[i];
    if (!productImageUrl) {
      send({ type: 'error', productId, productTitle, msg: 'Sin imagen en Shopify', done: i + 1, total: toProcess.length });
      continue;
    }
    try {
      const metafields    = await shopify.getProductMetafields(productId);
      const bgPrompt      = await buildBackgroundPrompt(productTitle, collectionTitle, metafields);
      const productBuffer = await shopify.downloadImageBuffer(productImageUrl);
      const [noBgBuffer, bgBuffer] = await Promise.all([
        removeBackground(productBuffer),
        generateBackground(bgPrompt),
      ]);
      const base64 = await compositeImages(bgBuffer, noBgBuffer, collectionTitle, metafields);

      generatedImages[productId] = base64;
      stats.generated++;
      stats.costUSD = Math.round((stats.costUSD + 0.06) * 100) / 100;

      generationLog.push({
        productId, productTitle, collectionTitle, prompt: bgPrompt, status: 'generated', ts: new Date().toISOString(),
      });

      const imageUrl = `/api/generated-image/${productId}`;
      send({ type: 'result', productId, productTitle, imageUrl, prompt: bgPrompt, done: i + 1, total: toProcess.length });
    } catch (e) {
      send({ type: 'error', productId, productTitle, msg: e.message, done: i + 1, total: toProcess.length });
    }
    await new Promise(r => setTimeout(r, 500));
  }

  send({ type: 'done', stats });
  res.end();
});

app.post('/api/approve', requireAuth, async (req, res) => {
  const { productId, productTitle } = req.body;
  if (!productId) return res.status(400).json({ error: 'Faltan parámetros' });
  const base64 = generatedImages[productId];
  if (!base64) return res.status(400).json({ error: 'Imagen no encontrada. Regenera primero.' });
  try {
    const filename = `bucarest-generated-${productId}-${Date.now()}.png`;
    const alt      = `Imagen contextual generada para ${productTitle}`;
    const image    = await shopify.uploadProductImage(productId, base64, filename, alt);

    stats.approved++;
    delete generatedImages[productId];
    const entry = generationLog.find(e => String(e.productId) === String(productId));
    if (entry) entry.status = 'approved';

    res.json({ success: true, image });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reject', requireAuth, (req, res) => {
  const { productId } = req.body;
  stats.rejected++;
  delete generatedImages[productId];
  const entry = generationLog.find(e => String(e.productId) === String(productId));
  if (entry) entry.status = 'rejected';
  res.json({ success: true });
});

app.get('/api/stats', requireAuth, (req, res) => {
  res.json({ ...stats, dailyLimit: DAILY_LIMIT, remaining: DAILY_LIMIT - stats.generated });
});

app.get('/api/log', requireAuth, (req, res) => {
  res.json({ log: generationLog });
});

// ── Static ────────────────────────────────────────────────────────────────────
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));

// ── Admin UI ──────────────────────────────────────────────────────────────────
function adminHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bucarest Image Generator</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0ece6;color:#2d2018;min-height:100vh}
.topbar{background:#2c4a3e;color:white;padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.topbar-title{font-size:16px;font-weight:600;letter-spacing:.3px}
.stats-bar{display:flex;gap:16px;align-items:center;font-size:13px;opacity:.9}
.stats-bar span{background:rgba(255,255,255,.12);padding:4px 10px;border-radius:12px}
.container{max-width:1400px;margin:0 auto;padding:24px}
.filter-card{background:white;border-radius:10px;padding:20px 24px;margin-bottom:20px;display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.form-group{display:flex;flex-direction:column;gap:6px;min-width:220px}
label{font-size:12px;font-weight:600;color:#6b5a4e;text-transform:uppercase;letter-spacing:.5px}
select,input{border:1px solid #ddd;border-radius:6px;padding:8px 12px;font-size:14px;color:#2d2018;background:white}
select:focus,input:focus{outline:none;border-color:#2c4a3e}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:#2c4a3e;color:white}.btn-primary:hover:not(:disabled){background:#1e3329}
.btn-secondary{background:#f5f0eb;color:#2d2018;border:1px solid #ddd}.btn-secondary:hover:not(:disabled){background:#ede7e0}
.btn-approve{background:#2d7a4e;color:white;font-size:12px;padding:7px 14px}.btn-approve:hover{background:#1f5c3a}
.btn-reject{background:#c0392b;color:white;font-size:12px;padding:7px 14px}.btn-reject:hover{background:#962d22}
.btn-sm{padding:6px 12px;font-size:12px}
.batch-bar{background:white;border-radius:10px;padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.cost-chip{background:#fef9f0;border:1px solid #f0d9a0;color:#7a5c1e;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600}
.products-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
.product-card{background:white;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);transition:box-shadow .2s;position:relative}
.product-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.1)}
.card-select{position:absolute;top:10px;left:10px;z-index:2}
.card-select input[type=checkbox]{width:18px;height:18px;cursor:pointer;accent-color:#2c4a3e}
.card-img-wrap{height:200px;overflow:hidden;background:#f5f0eb;position:relative}
.card-img-wrap img{width:100%;height:100%;object-fit:cover}
.card-img-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#b0a090;font-size:40px}
.card-body{padding:14px}
.card-title{font-size:13px;font-weight:600;color:#2d2018;margin-bottom:10px;line-height:1.4;min-height:36px}
.card-meta{font-size:11px;color:#9a8a7a;margin-bottom:10px}
.card-actions{display:flex;gap:8px;align-items:center}
.status-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 8px;border-radius:10px}
.badge-idle{background:#f0ece6;color:#9a8a7a}
.badge-generating{background:#e8f4fd;color:#1a6fa8}
.badge-preview{background:#fff8e1;color:#8a6c00}
.badge-approved{background:#e8f5e9;color:#2d7a4e}
.badge-rejected{background:#fce8e6;color:#c0392b}
.badge-error{background:#fce8e6;color:#c0392b}
.card-preview{border-top:1px solid #f0ece6;margin-top:12px;padding-top:12px}
.generated-img-wrap{border-radius:6px;overflow:hidden;margin-bottom:10px}
.generated-img-wrap img{width:100%;display:block}
.preview-actions{display:flex;gap:8px;margin-bottom:10px}
.prompt-details summary{font-size:11px;color:#9a8a7a;cursor:pointer;padding:4px 0}
.prompt-details p{font-size:11px;color:#6b5a4e;margin-top:6px;line-height:1.5;background:#f5f0eb;padding:8px;border-radius:4px;white-space:pre-wrap}
.progress-wrap{position:fixed;top:56px;left:0;right:0;z-index:200;background:white;border-bottom:1px solid #eee;padding:14px 24px;display:none}
.progress-bar-bg{background:#f0ece6;border-radius:99px;height:8px;overflow:hidden;margin:8px 0}
.progress-bar-fill{background:#2c4a3e;height:100%;border-radius:99px;transition:width .3s}
.progress-text{font-size:13px;color:#6b5a4e}
.empty-state{text-align:center;padding:60px 20px;color:#9a8a7a;font-size:14px}
.log-section{margin-top:24px;background:white;border-radius:10px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.log-title{font-size:14px;font-weight:600;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
.log-entry{font-size:12px;padding:6px 0;border-bottom:1px solid #f0ece6;display:flex;gap:10px;align-items:center}
.log-entry:last-child{border-bottom:none}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #ddd;border-top-color:#2c4a3e;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:24px;right:24px;background:#2c4a3e;color:white;padding:12px 20px;border-radius:8px;font-size:13px;z-index:999;display:none}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-title">🖼 Bucarest Image Generator</div>
  <div class="stats-bar" id="stats-bar">
    <span id="stat-generated">0 generadas</span>
    <span id="stat-approved">0 aprobadas</span>
    <span id="stat-cost">$0.00 USD</span>
  </div>
</div>

<div class="progress-wrap" id="progress-wrap">
  <div class="progress-text" id="progress-text">Generando...</div>
  <div class="progress-bar-bg"><div class="progress-bar-fill" id="progress-fill" style="width:0%"></div></div>
</div>

<div class="container">
  <div class="filter-card">
    <div class="form-group">
      <label>Colección</label>
      <select id="collection-select" onchange="onCollectionChange()">
        <option value="">Cargando colecciones...</option>
      </select>
    </div>
    <button class="btn btn-primary" id="btn-load" onclick="loadProducts()" disabled>
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Cargar productos
    </button>
  </div>

  <div class="batch-bar" id="batch-bar" style="display:none">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;text-transform:none;font-size:13px;font-weight:normal">
      <input type="checkbox" id="select-all" onchange="toggleSelectAll(this)" style="width:16px;height:16px;accent-color:#2c4a3e">
      Seleccionar todo
    </label>
    <span class="cost-chip" id="cost-estimate">Selecciona productos para ver el costo</span>
    <button class="btn btn-primary btn-sm" id="btn-batch" onclick="generateBatch()" disabled>
      Generar seleccionados
    </button>
    <button class="btn btn-secondary btn-sm" onclick="exportLog()">
      Exportar log CSV
    </button>
  </div>

  <div id="products-container">
    <div class="empty-state">Selecciona una colección para comenzar</div>
  </div>

  <div class="log-section" id="log-section" style="display:none">
    <div class="log-title">
      <span>Log de generaciones</span>
    </div>
    <div id="log-entries"></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script src="/app.js"></script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return res.redirect('/admin');
  res.send('Bucarest Image Generator — <a href="/shopify/auth">Conectar con Shopify</a>');
});

app.get('/admin', requireAuth, (req, res) => res.send(adminHTML()));

app.listen(PORT, () => console.log(`Bucarest Image Generator en puerto ${PORT}`));
