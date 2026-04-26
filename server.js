require('dotenv').config();
const express  = require('express');
const https    = require('https');
const path     = require('path');
const { toFile } = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI   = require('openai');
const shopify  = require('./shopify');
const { getContext, getSizeDescription } = require('./collections');

const app  = express();
const PORT = process.env.PORT || 3003;

app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors https://admin.shopify.com https://*.myshopify.com");
  next();
});

// ── Usage tracking ────────────────────────────────────────────────────────────
const DAILY_LIMIT = parseInt(process.env.DAILY_IMAGE_LIMIT) || 100;
let stats = { generated: 0, approved: 0, rejected: 0 };
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
  // Break out of Shopify iframe for OAuth (required by browsers)
  res.send(`<!DOCTYPE html><html><head>
    <script>window.top === window.self
      ? window.location.href = 'https://${shop}/admin/oauth/authorize?client_id=${key}&scope=${scopes}&redirect_uri=${redirect}'
      : window.top.location.href = 'https://${shop}/admin/oauth/authorize?client_id=${key}&scope=${scopes}&redirect_uri=${redirect}';
    </script></head></html>`);
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

// ── In-memory image store + caches ───────────────────────────────────────────
const generatedImages = {}; // { productId: base64 }
let allProductsCache  = null;

// ── Core AI logic ─────────────────────────────────────────────────────────────
async function buildPrompt(productTitle, collectionTitle, metafields, promptHint = null) {
  const context  = getContext(collectionTitle, productTitle, metafields);
  const sizeDesc = getSizeDescription(metafields.alto, metafields.ancho, collectionTitle);

  let msg;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Write an image editing prompt to place the antique piece "${productTitle}" (${collectionTitle}) into a beautiful aspirational interior scene, using the provided reference photo of the product.

The product should appear: ${context}
${sizeDesc ? `The piece is a ${sizeDesc}.` : ''}
${promptHint ? `\nAdditional instruction (takes priority over defaults above): ${promptHint}` : ''}

Requirements:
- Keep the product exactly as it appears in the reference photo — same colors, details, patina, texture
- The product is naturally integrated in the scene, at correct scale
- Warm natural light from the side or a window
- Neutral contemporary aspirational atmosphere
- Colors: warm whites, soft grays, natural wood tones
- No people, no clutter
- Photorealistic editorial interior photography
- 100 words max, describe the scene and product placement`,
      }],
      });
      break;
    } catch (e) {
      const status = e?.status || e?.response?.status;
      if (status === 429 && attempt < 4) {
        await new Promise(r => setTimeout(r, 15000 + attempt * 5000));
      } else if (status === 529 && attempt < 4) {
        await new Promise(r => setTimeout(r, (attempt + 1) * 8000));
      } else {
        throw e;
      }
    }
  }

  return msg.content[0].text.trim();
}

async function generateProductImage(productBuffer, prompt) {
  const file = await toFile(productBuffer, 'product.jpg', { type: 'image/jpeg' });
  const response = await getOpenAI().images.edit({
    model: 'gpt-image-1',
    image: file,
    prompt,
    size: '1024x1024',
  });
  return Buffer.from(response.data[0].b64_json, 'base64');
}

// ── Jimp font cache ───────────────────────────────────────────────────────────
const _fontCache = {};
async function loadFont(name) {
  if (!_fontCache[name]) {
    const Jimp = require('jimp');
    _fontCache[name] = await Jimp.loadFont(Jimp[name]);
  }
  return _fontCache[name];
}

function toAscii(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '');
}

async function makeGradientPng(width, height, maxOpacity = 0.62) {
  const sharp = require('sharp');
  const buf   = Buffer.alloc(width * height * 4, 0);
  const maxA  = Math.round(maxOpacity * 255);
  for (let y = 0; y < height; y++) {
    const a = Math.round((y / height) * maxA);
    for (let x = 0; x < width; x++) buf[(y * width + x) * 4 + 3] = a;
  }
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function addTextOverlay(imageBuffer, metafields) {
  const Jimp  = require('jimp');
  const sharp = require('sharp');
  const GH    = 310;

  const [gradPng, f32] = await Promise.all([
    makeGradientPng(1024, GH),
    loadFont('FONT_SANS_32_WHITE'),
  ]);

  const parts = [];
  if (metafields.alto)        parts.push('Alto: ' + metafields.alto);
  if (metafields.ancho)       parts.push('Ancho: ' + metafields.ancho);
  if (metafields.profundidad) parts.push('Prof.: ' + metafields.profundidad);
  const dimLine = toAscii(parts.join('  |  '));

  const textImg = new Jimp(1024, GH, 0x00000000);

  if (dimLine) {
    textImg.print(f32, 0, 20, { text: dimLine, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 1024);
  }
  textImg.print(f32, 20, 90, {
    text: toAscii('Atencion: Imagen exclusivamente referencial generada con IA.'),
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
  }, 984);
  textImg.print(f32, 20, 170, {
    text: toAscii('La pieza original difiere en color, textura, diseno, proporciones y tamano.'),
    alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
  }, 984);

  const textPng = await textImg.getBufferAsync(Jimp.MIME_PNG);

  const result = await sharp(imageBuffer)
    .resize(1024, 1024)
    .composite([
      { input: gradPng, top: 714, left: 0 },
      { input: textPng, top: 714, left: 0 },
    ])
    .png()
    .toBuffer();
  return result.toString('base64');
}

async function addMarketingOverlay(imageBuffer, customText) {
  const Jimp  = require('jimp');
  const sharp = require('sharp');

  if (!customText || !customText.trim()) {
    const result = await sharp(imageBuffer).resize(1024, 1024).png().toBuffer();
    return result.toString('base64');
  }

  const lines = customText.trim().split('\n').filter(Boolean).map(toAscii);
  const GH    = 304;

  const [gradPng, f32] = await Promise.all([
    makeGradientPng(1024, GH, 0.70),
    loadFont('FONT_SANS_32_WHITE'),
  ]);

  const textImg = new Jimp(1024, GH, 0x00000000);
  const lineH   = 46;
  const startY  = Math.max(10, GH - lines.length * lineH - 30);

  lines.forEach((line, i) => {
    textImg.print(f32, 0, startY + i * lineH, {
      text: line,
      alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
    }, 1024);
  });

  const textPng = await textImg.getBufferAsync(Jimp.MIME_PNG);

  const result = await sharp(imageBuffer)
    .resize(1024, 1024)
    .composite([
      { input: gradPng, top: 720, left: 0 },
      { input: textPng, top: 720, left: 0 },
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

app.get('/api/all-products', requireAuth, async (req, res) => {
  try {
    if (!allProductsCache) allProductsCache = await shopify.getAllProducts();
    res.json({ products: allProductsCache });
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

app.post('/api/suggest-prompt', requireAuth, async (req, res) => {
  const { productTitle, collectionTitle, productId } = req.body;
  if (!productTitle || !collectionTitle) return res.status(400).json({ error: 'Faltan parámetros' });
  try {
    const metafields = productId ? await shopify.getProductMetafields(productId) : {};
    const prompt = await buildPrompt(productTitle, collectionTitle, metafields);
    res.json({ prompt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate', requireAuth, async (req, res) => {
  const { productId, productTitle, collectionTitle, productImageUrl, customPrompt, promptHint } = req.body;
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
    const prompt        = customPrompt || await buildPrompt(productTitle, collectionTitle, metafields, promptHint);
    const productBuffer = await shopify.downloadImageBuffer(productImageUrl);
    const genBuffer     = await generateProductImage(productBuffer, prompt);
    const base64        = await addTextOverlay(genBuffer, metafields);

    generatedImages[productId] = base64;
    stats.generated++;

    generationLog.push({
      productId, productTitle, collectionTitle, prompt, status: 'generated', ts: new Date().toISOString(),
    });

    res.json({ imageUrl: `/api/generated-image/${productId}`, prompt, cost: 0.04 });
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
  res.setHeader('X-Accel-Buffering', 'no');
  const send = data => res.write('data: ' + JSON.stringify(data) + '\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 8000);
  res.on('close', () => clearInterval(ping));

  const remaining = DAILY_LIMIT - stats.generated;
  const toProcess = products.slice(0, remaining);

  send({ type: 'total', total: toProcess.length });

  for (let i = 0; i < toProcess.length; i++) {
    const { productId, productTitle, productImageUrl, promptHint } = toProcess[i];
    if (!productImageUrl) {
      send({ type: 'error', productId, productTitle, msg: 'Sin imagen en Shopify', done: i + 1, total: toProcess.length });
      continue;
    }
    try {
      const metafields    = await shopify.getProductMetafields(productId);
      const prompt        = await buildPrompt(productTitle, collectionTitle, metafields, promptHint);
      const productBuffer = await shopify.downloadImageBuffer(productImageUrl);
      const genBuffer     = await generateProductImage(productBuffer, prompt);
      const base64        = await addTextOverlay(genBuffer, metafields);

      generatedImages[productId] = base64;
      stats.generated++;

      generationLog.push({
        productId, productTitle, collectionTitle, prompt, status: 'generated', ts: new Date().toISOString(),
      });

      const imageUrl = `/api/generated-image/${productId}`;
      send({ type: 'result', productId, productTitle, imageUrl, prompt, done: i + 1, total: toProcess.length });
    } catch (e) {
      send({ type: 'error', productId, productTitle, msg: e.message, done: i + 1, total: toProcess.length });
    }
    await new Promise(r => setTimeout(r, 13000));
  }

  clearInterval(ping);
  send({ type: 'done', stats });
  res.end();
});

app.post('/api/generate-marketing', requireAuth, async (req, res) => {
  const { productImageUrl, prompt, overlayText } = req.body;
  if (!productImageUrl || !prompt)
    return res.status(400).json({ error: 'Faltan parámetros' });
  if (!process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: 'OpenAI API key no configurada.' });

  try {
    const productBuffer = await shopify.downloadImageBuffer(productImageUrl);
    const genBuffer     = await generateProductImage(productBuffer, prompt);
    const base64        = await addMarketingOverlay(genBuffer, overlayText);

    stats.generated++;

    res.json({ imageBase64: base64 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
function adminHTML(host = '') {
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
.tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:2px solid #e0d8d0;padding-bottom:0}
.tab-btn{padding:10px 22px;border-radius:6px 6px 0 0;font-size:13px;font-weight:600;cursor:pointer;border:none;background:transparent;color:#9a8a7a;transition:all .15s;margin-bottom:-2px;border-bottom:2px solid transparent}
.tab-btn.active{background:white;color:#2c4a3e;border-bottom:2px solid white}
.tab-panel{display:none}
.tab-panel.active{display:block}
.filter-card{background:white;border-radius:10px;padding:20px 24px;margin-bottom:20px;display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.form-group{display:flex;flex-direction:column;gap:6px;min-width:220px}
label{font-size:12px;font-weight:600;color:#6b5a4e;text-transform:uppercase;letter-spacing:.5px}
select,input,textarea{border:1px solid #ddd;border-radius:6px;padding:8px 12px;font-size:14px;color:#2d2018;background:white;font-family:inherit}
select:focus,input:focus,textarea:focus{outline:none;border-color:#2c4a3e}
textarea{resize:vertical;line-height:1.5}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:#2c4a3e;color:white}.btn-primary:hover:not(:disabled){background:#1e3329}
.btn-secondary{background:#f5f0eb;color:#2d2018;border:1px solid #ddd}.btn-secondary:hover:not(:disabled){background:#ede7e0}
.btn-approve{background:#2d7a4e;color:white;font-size:12px;padding:7px 14px}.btn-approve:hover{background:#1f5c3a}
.btn-reject{background:#c0392b;color:white;font-size:12px;padding:7px 14px}.btn-reject:hover{background:#962d22}
.btn-download{background:#1a5276;color:white;font-size:13px;padding:9px 18px}.btn-download:hover:not(:disabled){background:#154360}
.btn-sm{padding:6px 12px;font-size:12px}
.btn-xs{padding:4px 10px;font-size:11px;font-weight:600}
.batch-bar{background:white;border-radius:10px;padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.cost-chip{background:#fef9f0;border:1px solid #f0d9a0;color:#7a5c1e;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600}
.products-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
.product-card{background:white;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);transition:box-shadow .2s;position:relative}
.product-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.1)}
.card-select{position:absolute;top:10px;left:10px;z-index:2}
.card-select input[type=checkbox]{width:18px;height:18px;cursor:pointer;accent-color:#2c4a3e}
.card-img-wrap{aspect-ratio:1/1;overflow:hidden;background:#f5f0eb;position:relative}
.card-img-wrap img{width:100%;height:100%;object-fit:contain}
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
.card-preview{border-top:1px solid #f0ece6;margin-top:12px;padding:12px 14px 14px}
.generated-img-wrap{border-radius:6px;overflow:hidden;margin-bottom:10px;aspect-ratio:1/1}
.generated-img-wrap img{width:100%;height:100%;object-fit:cover;display:block}
.preview-actions{display:flex;gap:8px;margin-bottom:12px}
.prompt-editor label{font-size:11px;color:#9a8a7a;display:block;margin-bottom:4px;text-transform:none;letter-spacing:0;font-weight:400}
.prompt-editor textarea{width:100%;font-size:11px;padding:8px;border-radius:4px;min-height:80px;color:#4a3a2e;background:#faf8f5;border:1px solid #e0d8d0;resize:vertical;font-family:inherit;line-height:1.5}
.prompt-editor-actions{margin-top:6px}
.progress-wrap{position:fixed;top:56px;left:0;right:0;z-index:200;background:white;border-bottom:1px solid #eee;padding:14px 24px;display:none}
.progress-bar-bg{background:#f0ece6;border-radius:99px;height:8px;overflow:hidden;margin:8px 0}
.progress-bar-fill{background:#2c4a3e;height:100%;border-radius:99px;transition:width .3s}
.progress-text{font-size:13px;color:#6b5a4e}
.empty-state{text-align:center;padding:60px 20px;color:#9a8a7a;font-size:14px}
.log-section{margin-top:24px;background:white;border-radius:10px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.log-title{font-size:14px;font-weight:600;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
.log-entry{font-size:12px;padding:6px 0;border-bottom:1px solid #f0ece6;display:flex;gap:10px;align-items:center}
.log-entry:last-child{border-bottom:none}
.ai-badge{position:absolute;top:8px;right:8px;background:#2d7a4e;color:white;font-size:10px;font-weight:700;padding:3px 7px;border-radius:10px;z-index:2;pointer-events:none}
.draft-badge{position:absolute;top:8px;left:36px;background:#7a5c1e;color:white;font-size:10px;font-weight:700;padding:3px 7px;border-radius:10px;z-index:2;pointer-events:none}
.nostock-badge{position:absolute;top:32px;left:36px;background:#888;color:white;font-size:10px;font-weight:700;padding:3px 7px;border-radius:10px;z-index:2;pointer-events:none}
.product-card.has-ai{border:2px solid #a8d5bb}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #ddd;border-top-color:#2c4a3e;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:24px;right:24px;background:#2c4a3e;color:white;padding:12px 20px;border-radius:8px;font-size:13px;z-index:999;display:none}
.mkt-card{background:white;border-radius:10px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.06);max-width:720px}
.mkt-card h2{font-size:15px;font-weight:600;margin-bottom:6px}
.mkt-card > p{font-size:13px;color:#6b5a4e;margin-bottom:24px;line-height:1.6}
.mkt-product-row{display:flex;gap:20px;align-items:flex-start;margin-bottom:20px}
.mkt-product-thumb{width:110px;height:110px;border-radius:8px;object-fit:contain;background:#f5f0eb;border:1px solid #e8e0d8;flex-shrink:0}
.mkt-product-thumb-empty{width:110px;height:110px;border-radius:8px;background:#f5f0eb;border:1px solid #e8e0d8;display:flex;align-items:center;justify-content:center;color:#c0a890;font-size:32px;flex-shrink:0}
.mkt-fields{flex:1;display:flex;flex-direction:column;gap:14px}
.mkt-label-row{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.mkt-label-row label{margin-bottom:0}
.mkt-result{margin-top:28px;display:none}
.mkt-result img{width:100%;border-radius:8px;display:block;margin-bottom:14px;aspect-ratio:1/1;object-fit:cover}
.mkt-divider{border:none;border-top:1px solid #e8e0d8;margin:24px 0}
.mkt-autocomplete{position:relative}
.mkt-dropdown{position:absolute;top:calc(100% + 2px);left:0;right:0;background:white;border:1px solid #c8bfb5;border-radius:6px;max-height:260px;overflow-y:auto;z-index:60;box-shadow:0 6px 16px rgba(0,0,0,.1);display:none}
.mkt-dropdown-item{padding:10px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0ece6;line-height:1.4}
.mkt-dropdown-item:hover{background:#f5f0eb}
.mkt-dropdown-item:last-child{border-bottom:none}
.mkt-dropdown-empty{padding:10px 14px;font-size:13px;color:#9a8a7a}
.mkt-selected-chip{display:none;align-items:center;gap:10px;margin-top:8px;padding:8px 12px;background:#eef4f0;border:1px solid #c2d9cc;border-radius:6px}
.mkt-selected-chip img{width:36px;height:36px;object-fit:contain;border-radius:4px;background:white;border:1px solid #ddd;flex-shrink:0}
.mkt-selected-chip-name{flex:1;font-size:12px;font-weight:600;color:#2c4a3e;line-height:1.3}
.mkt-clear{background:none;border:none;cursor:pointer;color:#7a9a8a;font-size:16px;line-height:1;padding:2px 4px;flex-shrink:0}
.mkt-clear:hover{color:#2c4a3e}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-title">Bucarest Image Generator</div>
  <div class="stats-bar" id="stats-bar">
    <span id="stat-generated">0 generadas</span>
    <span id="stat-approved">0 aprobadas</span>
  </div>
</div>

<div class="progress-wrap" id="progress-wrap">
  <div class="progress-text" id="progress-text">Generando...</div>
  <div class="progress-bar-bg"><div class="progress-bar-fill" id="progress-fill" style="width:0%"></div></div>
</div>

<div class="container">
  <div class="tabs">
    <button class="tab-btn active" data-tab="catalog" onclick="switchTab('catalog')">Catálogo</button>
    <button class="tab-btn" data-tab="marketing" onclick="switchTab('marketing')">Marketing</button>
  </div>

  <div class="tab-panel active" id="tab-catalog">
    <div class="filter-card">
      <div class="form-group">
        <label>Colección</label>
        <select id="collection-select" onchange="onCollectionChange()">
          <option value="">Cargando colecciones...</option>
        </select>
      </div>
      <div class="form-group" style="min-width:160px">
        <label>Estado</label>
        <select id="filter-status" onchange="applyFilters()">
          <option value="">Todos</option>
          <option value="active">Activo</option>
          <option value="draft">Borrador</option>
        </select>
      </div>
      <div class="form-group" style="min-width:160px">
        <label>Stock</label>
        <select id="filter-stock" onchange="applyFilters()">
          <option value="">Todos</option>
          <option value="available">Con stock</option>
          <option value="unavailable">Sin stock</option>
        </select>
      </div>
      <button class="btn btn-primary" id="btn-load" onclick="loadProducts()" disabled>
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Cargar productos
      </button>
    </div>

    <div class="filter-card" id="hint-card" style="display:none;flex-direction:column;align-items:stretch;gap:8px">
      <label style="font-size:12px;font-weight:600;color:#6b5a4e;text-transform:uppercase;letter-spacing:.5px">
        Instrucción adicional al prompt <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#9a8a7a;font-size:11px">(opcional — se suma al contexto de Claude para todos los productos)</span>
      </label>
      <textarea id="catalog-prompt-hint" rows="2" style="resize:vertical;font-size:13px;color:#4a3a2e" placeholder="Ej: colócalos en un living como mesa de apoyo, no en dormitorio"></textarea>
    </div>

    <div class="batch-bar" id="batch-bar" style="display:none">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;text-transform:none;font-size:13px;font-weight:normal">
        <input type="checkbox" id="select-all" onchange="toggleSelectAll(this)" style="width:16px;height:16px;accent-color:#2c4a3e">
        Seleccionar todo
      </label>
      <button class="btn btn-secondary btn-sm" onclick="selectWithoutGenerated()">
        Seleccionar sin IA aprobada
      </button>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;text-transform:none;font-size:13px;font-weight:normal">
        <input type="checkbox" id="hide-generated" onchange="toggleHideGenerated(this)" style="width:16px;height:16px;accent-color:#2c4a3e">
        Ocultar con IA aprobada
      </label>
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
      <div class="log-title"><span>Log de generaciones</span></div>
      <div id="log-entries"></div>
    </div>
  </div>

  <div class="tab-panel" id="tab-marketing">
    <div class="mkt-card">
      <h2>Generar imagen para marketing</h2>
      <p>Selecciona un producto de la colección cargada, escribe o sugiere un prompt, y agrega texto opcional que aparecerá en la imagen. La imagen generada se puede descargar directamente.</p>

      <div class="form-group" style="margin-bottom:20px">
        <label>Buscar producto por título</label>
        <div class="mkt-autocomplete">
          <input type="text" id="mkt-search" placeholder="Escribe parte del título..." oninput="filterMarketingProducts()" autocomplete="off">
          <div id="mkt-dropdown" class="mkt-dropdown"></div>
        </div>
        <div id="mkt-selected-chip" class="mkt-selected-chip">
          <img id="mkt-chip-img" src="" alt="">
          <span id="mkt-chip-name" class="mkt-selected-chip-name"></span>
          <button class="mkt-clear" onclick="clearMarketingProduct()" title="Cambiar producto">✕</button>
        </div>
      </div>

      <div class="mkt-product-row">
        <div id="mkt-thumb-wrap"><div class="mkt-product-thumb-empty">🖼</div></div>
        <div class="mkt-fields">
          <div class="form-group">
            <div class="mkt-label-row">
              <label>Prompt</label>
              <button class="btn btn-secondary btn-xs" id="btn-suggest" onclick="suggestMarketingPrompt()">✨ Sugerir con IA</button>
            </div>
            <textarea id="mkt-prompt" rows="5" placeholder="Describe la escena aspiracional que quieres generar..."></textarea>
          </div>
          <div class="form-group">
            <label>Texto en imagen <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#9a8a7a;font-size:11px">(opcional)</span></label>
            <textarea id="mkt-overlay-text" rows="2" placeholder="Ej: Nueva colección&#10;Bucarest Art &amp; Antiques"></textarea>
          </div>
        </div>
      </div>

      <button class="btn btn-primary" id="btn-mkt-generate" onclick="generateMarketing()" disabled>
        Generar imagen
      </button>

      <div class="mkt-result" id="mkt-result">
        <hr class="mkt-divider">
        <img id="mkt-result-img" src="" alt="Imagen generada para marketing">
        <button class="btn btn-download" onclick="downloadMarketingImage()">↓ Descargar imagen</button>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>
<script src="/app.js"></script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return res.redirect(`/admin${req.query.host ? '?host=' + req.query.host : ''}`);
  res.redirect('/shopify/auth');
});

app.get('/admin', (req, res) => {
  if (!process.env.SHOPIFY_ACCESS_TOKEN) return res.redirect('/shopify/auth');
  res.send(adminHTML(req.query.host || ''));
});

app.listen(PORT, () => console.log(`Bucarest Image Generator en puerto ${PORT}`));
