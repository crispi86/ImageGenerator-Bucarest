const https = require('https');
const { TARGET_COLLECTIONS } = require('./collections');

function shopifyRequest(method, path, body = null) {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const shop  = process.env.SHOPIFY_SHOP;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: shop,
      path: `/admin/api/2024-01/${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ body: JSON.parse(data), headers: res.headers }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function getNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function getAllPages(path, key) {
  let results = [];
  const sep = path.includes('?') ? '&' : '?';
  let current = `${path}${sep}limit=250`;
  while (true) {
    const { body, headers } = await shopifyRequest('GET', current);
    const items = body[key];
    if (!items || items.length === 0) break;
    results = results.concat(items);
    const next = getNextPageInfo(headers['link']);
    if (!next) break;
    const base = path.split('?')[0];
    current = `${base}?limit=250&page_info=${next}`;
    await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

async function getTargetCollections() {
  const custom = await getAllPages('custom_collections.json?fields=id,title,image', 'custom_collections');
  const smart  = await getAllPages('smart_collections.json?fields=id,title,image', 'smart_collections');
  return [...custom, ...smart].sort((a, b) => a.title.localeCompare(b.title));
}

async function getAllProducts() {
  const fields = 'id,title,images';
  const products = await getAllPages(`products.json?status=active&fields=${fields}`, 'products');
  return products
    .filter(p => p.images?.length > 0)
    .map(p => ({ id: p.id, title: p.title, image: p.images[0].src }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function getProductsByCollection(collectionId) {
  const fields = 'id,title,images,variants,status';
  const products = await getAllPages(
    `products.json?collection_id=${collectionId}&status=active&fields=${fields}`,
    'products'
  );
  return products.map(p => ({
    id: p.id,
    title: p.title,
    status: p.status,
    image: p.images?.[0]?.src || null,
    imageCount: p.images?.length || 0,
  }));
}

async function getProductMetafields(productId) {
  const { body } = await shopifyRequest('GET', `products/${productId}/metafields.json?namespace=custom`);
  const mf = {};
  for (const m of body.metafields || []) {
    mf[m.key] = m.value;
  }
  return mf;
}

async function uploadProductImage(productId, base64, filename, alt) {
  const { body } = await shopifyRequest('POST', `products/${productId}/images.json`, {
    image: { attachment: base64, filename, alt },
  });
  return body.image;
}

function downloadImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : require('http');
    lib.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImageBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = {
  shopifyRequest,
  getAllPages,
  getTargetCollections,
  getAllProducts,
  getProductsByCollection,
  getProductMetafields,
  uploadProductImage,
  downloadImageBuffer,
};
