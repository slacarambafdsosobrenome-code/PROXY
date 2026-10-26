module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  try {
    const target = req.query.url;
    if (!target || typeof target !== 'string') {
      return res.status(400).send('Missing ?url=');
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return res.status(400).send('Invalid url');
    }

    if (parsed.protocol !== 'https:') {
      return res.status(403).send('Only https allowed');
    }

    const host = parsed.hostname.toLowerCase();
    const allowed =
      host === 'redeflixapi.store' ||
      host.endsWith('.redeflixapi.bar') ||
      host === 'mgeb.top' ||
      host.endsWith('.mgeb.top') ||
      host === 'mgeb.site' ||
      host.endsWith('.mgeb.site') ||
      host === 'megaembed.com' ||
      host.endsWith('.megaembed.com') ||
      host === 'playercdn.xyz' ||
      host.endsWith('.playercdn.xyz');

    if (!allowed) {
      return res.status(403).send('Domínio não permitido: ' + host);
    }

    const fetchOpts = {
      method: req.method === 'HEAD' ? 'GET' : req.method,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://redeflixapi.bar/',
        Origin: 'https://redeflixapi.bar',
        Accept: '*/*',
      },
      redirect: 'follow',
    };

    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) fetchOpts.body = Buffer.concat(chunks);
    }

    const upstream = await fetch(target, fetchOpts);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buffer);
  } catch (e) {
    console.error('Proxy error:', e);
    return res.status(502).send('Proxy fail: ' + e.message);
  }
};
