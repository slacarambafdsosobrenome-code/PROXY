module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(204).end();
  }

  try {
    const pathParts = req.query.path;
    if (!pathParts || !pathParts.length) {
      return res.status(400).send('Missing target');
    }

    const hostAndPath = Array.isArray(pathParts) ? pathParts.join('/') : pathParts;
    const targetUrl = 'https://' + hostAndPath + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');

    const host = hostAndPath.split('/')[0].toLowerCase();
    const allowed =
      host === 'redeflixapi.store' || host.endsWith('.redeflixapi.store') ||
      host === 'mgeb.top' || host.endsWith('.mgeb.top') ||
      host === 'mgeb.site' || host.endsWith('.mgeb.site') ||
      host === 'megaembed.com' || host.endsWith('.megaembed.com') ||
      host === 'playercdn.xyz' || host.endsWith('.playercdn.xyz');

    if (!allowed) {
      return res.status(403).send('Domínio não permitido: ' + host);
    }

    const fetchOpts = {
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://redeflixapi.store/',
        'Origin': 'https://redeflixapi.store',
        'Accept': '*/*'
      },
      redirect: 'follow'
    };

    if (req.method === 'POST' || req.method === 'PUT') {
      // body já vem parseado ou raw dependendo da config; para simplicidade:
      if (req.body) fetchOpts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }

    const upstream = await fetch(targetUrl, fetchOpts);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);

    // remove headers problemáticos
    // (X-Frame-Options etc. já não vêm na response do fetch daqui)

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buffer);

  } catch (e) {
    return res.status(502).send('Proxy fail: ' + e.message);
  }
};