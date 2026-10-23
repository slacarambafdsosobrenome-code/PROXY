module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(204).end();
  }

  try {
    // path completo: redeflixapi.store/playerkys/assets/css/player.css
    let raw = req.query.raw;
    if (!raw || typeof raw !== 'string') {
      return res.status(400).send('Missing path. Ex: /p/redeflixapi.store/playerkys/index.html');
    }
    raw = decodeURIComponent(raw).replace(/^\/+/, '');

    // monta URL final + query (exceto "raw")
    const u = new URL('https://' + raw);
    const incoming = new URL(req.url, 'http://x');
    incoming.searchParams.forEach((v, k) => {
      if (k !== 'raw') u.searchParams.set(k, v);
    });
    const finalUrl = u.href;
    const host = u.hostname.toLowerCase();

    const allowed =
      host === 'redeflixapi.store' ||
      host.endsWith('.redeflixapi.store');

    if (!allowed) {
      return res.status(403).send('Domínio não permitido: ' + host);
    }

    const fetchOpts = {
      method: req.method === 'HEAD' ? 'GET' : req.method,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://redeflixapi.store/',
        Origin: 'https://redeflixapi.store',
        Accept: '*/*',
      },
      redirect: 'follow',
    };

    if (req.method === 'POST' || req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (chunks.length) fetchOpts.body = Buffer.concat(chunks);
    }

    const upstream = await fetch(finalUrl, fetchOpts);
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const origin = `https://${req.headers.host}`;

    // ===== HTML: reescreve caminhos absolutos /playerkys e /js =====
    if (ct.includes('text/html')) {
      let html = await upstream.text();

      // remove ads
      html = html
        .replace(/<script[^>]*src=["'][^"']*player-popunder[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*src=["'][^"']*player-isolation[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*src=["'][^"']*tynt\.com[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*src=["'][^"']*waust\.at[^"']*["'][\s\S]*?<\/script>/gi, '');

      // /playerkys/...  e  /js/...  →  /p/redeflixapi.store/...
      html = html.replace(
        /(src|href)=["'](\/(?:playerkys|js)[^"']*)["']/gi,
        (_, attr, p) => `${attr}="${origin}/p/redeflixapi.store${p}"`
      );

      // https://redeflixapi.store/... → /p/redeflixapi.store/...
      html = html.replace(
        /(src|href)=["']https?:\/\/redeflixapi\.store([^"']*)["']/gi,
        (_, attr, p) => `${attr}="${origin}/p/redeflixapi.store${p}"`
      );

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.status(upstream.status).send(html);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (ct) res.setHeader('Content-Type', ct);

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(502).send('Proxy fail: ' + e.message + '\n\nraw=' + (req.query.raw || ''));
  }
};
