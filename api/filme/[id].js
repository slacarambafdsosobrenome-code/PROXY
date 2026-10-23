const BASE = 'https://redeflixapi.store';

module.exports = async function handler(req, res) {
  const { id } = req.query;

  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).send('Use /filme/{tmdb_id}');
  }

  try {
    const target = `${BASE}/filme/${id}`;
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Referer': 'https://redeflixapi.store/',
        'Origin': 'https://redeflixapi.store',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow'
    });

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      return res.status(502).send(
        `ERRO UPSTREAM\nStatus: ${upstream.status}\nURL: ${target}\n\n${body.slice(0, 600)}`
      );
    }

    let html = await upstream.text();
    const origin = `https://${req.headers.host}`;

    html = cleanAds(html);
    html = rewriteDomains(html, origin);

    if (html.includes('<head>')) {
      html = html.replace(/<head>/i, `<head><meta name="referrer" content="no-referrer">`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(html);

  } catch (e) {
    return res.status(500).send('Erro: ' + e.message);
  }
};

// ==================== HELPERS ====================

function rewriteDomains(html, origin) {
  const domains = [
    'redeflixapi\\.store',
    'mgeb\\.top',
    'mgeb\\.site',
    'megaembed\\.com',
    'playercdn\\.xyz',
  ];
  const pattern = domains.join('|');

  // https://dominio/... e //dominio/...
  const regex = new RegExp(
    `(https?:)?\\/\\/((?:[a-z0-9\\-]+\\.)*(?:${pattern}))([^"'\\s>]*)`,
    'gi'
  );

  const map = new Map();
  let m;
  while ((m = regex.exec(html)) !== null) {
    const full = m[0];
    const host = m[2];
    const rest = m[3] || '';
    if (!map.has(full)) {
      // /p/host/path?query
      map.set(full, `${origin}/p/${host}${rest}`);
    }
  }
  for (const [from, to] of map) {
    html = html.split(from).join(to);
  }

  // caminhos relativos do site
  html = html.replace(
    /(src|href)=["'](\/(?:playerkys|js|player|css|playback-resolve)[^"']*)["']/gi,
    (_, attr, p) => `${attr}="${origin}/p/redeflixapi.store${p}"`
  );

  return html;
}

function cleanAds(html) {
  html = html
    .replace(/<script[^>]*src=["'][^"']*player-popunder\.js[^"']*["'][\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*player-isolation\.js[^"']*["'][\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*tynt\.com[^"']*["'][\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*id=["']aclib["'][\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*acscdn\.com[^"']*["'][\s\S]*?<\/script>/gi, '')
    .replace(/aclib\.runPop\s*\([^)]*\)\s*;?/gi, '')
    .replace(/<script[^>]*id=["']_waubik["'][\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*waust\.at[^"']*["'][\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*disable-devtool[^"']*["'][\s\S]*?<\/script>/gi, '')
    .replace(/DisableDevtool\s*\(\s*\{[\s\S]*?\}\s*\)\s*;?/gi, '')
    .replace(/window\.location\.href\s*=\s*["'][^"']*onclickperformance[^"']*["']/gi, '/*blocked*/')
    .replace(/window\.location\.href\s*=\s*["']https:\/\/[^"']*sandbox\.php[^"']*["']/gi, '/*skip*/')
    .replace(/<noscript>[\s\S]*?Sandbox Detectada[\s\S]*?<\/noscript>/gi, '');

  const bad = [
    'comeumamao\\.monster', 'rdembed\\.sbs',
    'azureedgeglobalfastlycloudfrontondigitaloceanstackpathcdn\\.buzz',
    'best\\/demo\\/vast\\.php', 'imasdk\\.googleapis\\.com',
    'googleads\\.g\\.doubleclick\\.net', 'pagead2\\.googlesyndication\\.com',
    'adservice\\.google', 'googlesyndication\\.com', 'doubleclick\\.net',
    'omweb-v1\\.js', 'vast\\.php', 'onclickperformance',
    'waust\\.at', 'acscdn\\.com', 'tynt\\.com', 'player-popunder'
  ];

  for (const d of bad) {
    html = html.replace(new RegExp(`<script[^>]*src=["'][^"']*${d}[^"']*["'][^>]*>[\\s\\S]*?<\\/script>`, 'gi'), '');
    html = html.replace(new RegExp(`<script[^>]*src=["'][^"']*${d}[^"']*["'][^>]*\\/?>`, 'gi'), '');
    html = html.replace(new RegExp(`<iframe[^>]*src=["'][^"']*${d}[^"']*["'][^>]*>[\\s\\S]*?<\\/iframe>`, 'gi'), '');
    html = html.replace(new RegExp(`<(?:img|link|source)[^>]*(?:src|href)=["'][^"']*${d}[^"']*["'][^>]*\\/?>`, 'gi'), '');
  }

  html = html.replace(
    /https?:\/\/(?:[a-z0-9\-]+\.)*(?:comeumamao\.monster|rdembed\.sbs|tynt\.com)[^"'\\\s>]*/gi,
    'about:blank'
  );

  html = html.replace(
    /<script[^>]*>[\s\S]*?(?:vast\.php|imasdk|googleads|doubleclick|googlesyndication|popunder|tynt)[\s\S]*?<\/script>/gi,
    ''
  );

  return html;
}
