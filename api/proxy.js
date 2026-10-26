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
      host === 'redeflixapi.bar' ||
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
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const origin = `https://${req.headers.host}`;

    // ===== Se for HTML, reescreve os links internos =====
    if (ct.includes('text/html')) {
      let html = await upstream.text();

      // remove scripts de ad / isolation / popunder
      html = html
        .replace(/<script[^>]*src=["'][^"']*player-popunder[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*src=["'][^"']*player-isolation[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*src=["'][^"']*tynt\.com[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<link[^>]*href=["'][^"']*cdn-cgi[^"']*["'][^>]*>/gi, '');

      html = rewriteHtmlAssets(html, origin, parsed);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.status(upstream.status).send(html);
    }

    // ===== CSS: reescreve url() =====
    if (ct.includes('text/css')) {
      let css = await upstream.text();
      css = rewriteCssUrls(css, origin, parsed);

      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(upstream.status).send(css);
    }

    // ===== resto (js, m3u8, ts, imagem, etc.) =====
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (ct) res.setHeader('Content-Type', ct);

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buffer);
  } catch (e) {
    console.error('Proxy error:', e);
    return res.status(502).send('Proxy fail: ' + e.message);
  }
};

// ---------- helpers ----------

function proxyUrl(origin, absoluteUrl) {
  return `${origin}/api/proxy?url=${encodeURIComponent(absoluteUrl)}`;
}

function toAbsolute(baseUrl, relativeOrAbsolute) {
  try {
    return new URL(relativeOrAbsolute, baseUrl).href;
  } catch {
    return null;
  }
}

function rewriteHtmlAssets(html, origin, pageUrl) {
  const base = pageUrl.href;

  // src="..." e href="..." (relativos e absolutos do domínio permitido)
  html = html.replace(
    /(src|href)=["']([^"']+)["']/gi,
    (match, attr, val) => {
      if (
        !val ||
        val.startsWith('data:') ||
        val.startsWith('blob:') ||
        val.startsWith('mailto:') ||
        val.startsWith('javascript:') ||
        val.startsWith('#')
      ) {
        return match;
      }

      // já está no nosso proxy
      if (val.includes('/api/proxy?url=')) return match;

      const abs = toAbsolute(base, val);
      if (!abs) return match;

      try {
        const u = new URL(abs);
        const h = u.hostname.toLowerCase();
        const ok =
          h === 'redeflixapi.bar' ||
          h.endsWith('.redeflixapi.bar') ||
          h === 'mgeb.top' ||
          h.endsWith('.mgeb.top') ||
          h === 'mgeb.site' ||
          h.endsWith('.mgeb.site') ||
          h === 'megaembed.com' ||
          h.endsWith('.megaembed.com') ||
          h === 'playercdn.xyz' ||
          h.endsWith('.playercdn.xyz') ||
          h === 'ssl.p.jwpcdn.com' ||
          h.endsWith('.jwpcdn.com');

        // só proxya o que precisa; jwplayer CDN pode ir direto
        if (h === 'ssl.p.jwpcdn.com' || h.endsWith('.jwpcdn.com')) {
          return `${attr}="${abs}"`;
        }

        if (ok || val.startsWith('/') || val.startsWith('./') || val.startsWith('../') || !val.includes('://')) {
          // relativo ou domínio permitido → proxy
          if (ok || !val.includes('://')) {
            return `${attr}="${proxyUrl(origin, abs)}"`;
          }
        }
      } catch {}

      return match;
    }
  );

  // srcset
  html = html.replace(/srcset=["']([^"']+)["']/gi, (match, val) => {
    const parts = val.split(',').map((part) => {
      const bits = part.trim().split(/\s+/);
      const url = bits[0];
      const rest = bits.slice(1).join(' ');
      const abs = toAbsolute(base, url);
      if (!abs) return part;
      try {
        const u = new URL(abs);
        if (u.hostname.includes('redeflixapi.bar') || !url.includes('://')) {
          return proxyUrl(origin, abs) + (rest ? ' ' + rest : '');
        }
      } catch {}
      return part;
    });
    return `srcset="${parts.join(', ')}"`;
  });

  return html;
}

function rewriteCssUrls(css, origin, pageUrl) {
  const base = pageUrl.href;
  return css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi, (match, val) => {
    if (!val || val.startsWith('data:')) return match;
    const abs = toAbsolute(base, val);
    if (!abs) return match;
    try {
      const u = new URL(abs);
      if (
        u.hostname.includes('redeflixapi.bar') ||
        val.startsWith('/') ||
        val.startsWith('./') ||
        val.startsWith('../')
      ) {
        return `url("${proxyUrl(origin, abs)}")`;
      }
    } catch {}
    return match;
  });
}
