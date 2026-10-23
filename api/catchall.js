module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  try {
    let raw = req.query.raw;
    if (!raw || typeof raw !== 'string') {
      return res.status(400).send('Missing path');
    }
    raw = decodeURIComponent(raw).replace(/^\/+/, '');

    const u = new URL('https://' + raw);
    const incoming = new URL(req.url, 'http://x');
    incoming.searchParams.forEach((v, k) => {
      if (k !== 'raw') u.searchParams.set(k, v);
    });
    const finalUrl = u.href;
    const host = u.hostname.toLowerCase();

    if (host !== 'redeflixapi.store' && !host.endsWith('.redeflixapi.store')) {
      return res.status(403).send('Domínio não permitido: ' + host);
    }

    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://redeflixapi.store/playerkys/index.html',
      Origin: 'https://redeflixapi.store',
      Accept: '*/*',
      'X-Requested-With': 'RedeFlixPlayer',
    };

    const reqCt = req.headers['content-type'];
    if (reqCt) headers['Content-Type'] = reqCt;

    const fetchOpts = {
      method: req.method === 'HEAD' ? 'GET' : req.method,
      headers,
      redirect: 'follow',
    };

    // ===== BODY (importante na Vercel) =====
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      let bodyBuf = null;

      // 1) body já parseado pela Vercel
      if (req.body !== undefined && req.body !== null && req.body !== '') {
        if (Buffer.isBuffer(req.body)) {
          bodyBuf = req.body;
        } else if (typeof req.body === 'string') {
          bodyBuf = Buffer.from(req.body);
        } else {
          bodyBuf = Buffer.from(JSON.stringify(req.body));
          if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
          }
        }
      } else {
        // 2) tenta ler a stream
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          if (chunks.length) bodyBuf = Buffer.concat(chunks);
        } catch (e) {}
      }

      if (bodyBuf && bodyBuf.length) {
        fetchOpts.body = bodyBuf;
      }
    }

    const upstream = await fetch(finalUrl, fetchOpts);
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const origin = `https://${req.headers.host}`;

    // ===== HTML =====
    if (ct.includes('text/html')) {
      let html = await upstream.text();

      html = html
        .replace(/<script[^>]*src=["'][^"']*player-popunder[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*src=["'][^"']*player-isolation[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*src=["'][^"']*tynt\.com[^"']*["'][\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*src=["'][^"']*waust\.at[^"']*["'][\s\S]*?<\/script>/gi, '');

      html = html.replace(
        /(src|href)=["'](\/(?:playerkys|js)[^"']*)["']/gi,
        (_, attr, p) => `${attr}="${origin}/p/redeflixapi.store${p}"`
      );

      html = html.replace(
        /(src|href)=["']https?:\/\/redeflixapi\.store([^"']*)["']/gi,
        (_, attr, p) => `${attr}="${origin}/p/redeflixapi.store${p}"`
      );

      const inject = `
<script>
(function () {
  var ORIGIN = ${JSON.stringify(origin)};
  var PREFIX = ORIGIN + '/p/redeflixapi.store';
    function fixUrl(url) {
    if (!url || typeof url !== 'string') return url;
    try {
      // source e resolve NÃO passam pelo proxy (ticket amarrado ao device)
      if (
        url.indexOf('/playerkys/source.php') !== -1 ||
        url.indexOf('playerkys/source.php') !== -1 ||
        url.indexOf('/playback-resolve.php') !== -1 ||
        url.indexOf('playback-resolve.php') !== -1
      ) {
        if (url.charAt(0) === '/') {
          return 'https://redeflixapi.store' + url;
        }
        if (url.indexOf('https://redeflixapi.store') === 0) return url;
        // se veio pelo nosso domínio
        var idx = url.indexOf('/playerkys/source.php');
        if (idx !== -1) return 'https://redeflixapi.store/playerkys/source.php' + url.slice(idx + '/playerkys/source.php'.length);
        idx = url.indexOf('/playback-resolve.php');
        if (idx !== -1) return 'https://redeflixapi.store/playback-resolve.php' + url.slice(idx + '/playback-resolve.php'.length);
      }

      if (url.indexOf('/p/redeflixapi.store') !== -1) return url;

      if (url.charAt(0) === '/' && (
        url.indexOf('/playerkys/') === 0 ||
        url.indexOf('/js/') === 0
      )) {
        return PREFIX + url;
      }

      if (url.indexOf('https://redeflixapi.store') === 0) {
        return PREFIX + url.slice('https://redeflixapi.store'.length);
      }
    } catch (e) {}
    return url;
  }
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      if (typeof input === 'string') input = fixUrl(input);
      else if (input && typeof Request !== 'undefined' && input instanceof Request) {
        try { input = new Request(fixUrl(input.url), input); } catch (e) {}
      }
      return _fetch.call(this, input, init);
    };
  }
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = fixUrl(url);
    return _open.apply(this, arguments);
  };
})();
</script>`;

      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => m + inject);
      } else {
        html = inject + html;
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=30');
      return res.status(upstream.status).send(html);
    }

    // ===== JS: reescreve strings hardcoded =====
    if (ct.includes('javascript') || ct.includes('ecmascript') || finalUrl.endsWith('.js')) {
      let js = await upstream.text();
      js = js
        .replace(/([\"'])\/playerkys\//g, `$1${origin}/p/redeflixapi.store/playerkys/`)
        .replace(/([\"'])\/js\//g, `$1${origin}/p/redeflixapi.store/js/`)
        .replace(/https?:\/\/redeflixapi\.store/g, origin + '/p/redeflixapi.store');

      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(upstream.status).send(js);
    }

    // ===== resto =====
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD, POST');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (ct) res.setHeader('Content-Type', ct);

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(502).send('Proxy fail: ' + e.message);
  }
};
