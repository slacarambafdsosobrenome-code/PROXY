const BASE = 'https://redeflixapi.store';

// copia as mesmas funções cleanAds e rewriteDomains do arquivo de filme
// (ou extrai pra um arquivo compartilhado se quiser)

module.exports = async function handler(req, res) {
  const { id, season, ep } = req.query;

  if (!id || !season || !ep) {
    return res.status(400).send('Use /serie/{tmdb_id}/{temporada}/{episodio}');
  }

  try {
    const target = `${BASE}/serie/${id}/${season}/${ep}`;
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Referer': 'https://redeflixapi.store/',
        'Origin': 'https://redeflixapi.store'
      },
      redirect: 'follow'
    });

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      return res.status(502).send(`ERRO UPSTREAM ${upstream.status}\n${body.slice(0, 500)}`);
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

// Cole aqui as mesmas funções cleanAds e rewriteDomains do arquivo de filme
function rewriteDomains(html, origin) {
  const domains = ['redeflixapi\\.store', 'mgeb\\.top', 'mgeb\\.site', 'megaembed\\.com', 'playercdn\\.xyz'];
  const pattern = domains.join('|');
  const regex = new RegExp(`(https?:)?\\/\\/((?:[a-z0-9\\-]+\\.)*(?:${pattern}))([^"'\\s>]*)`, 'gi');
  const map = new Map();
  let m;
  while ((m = regex.exec(html)) !== null) {
    const full = m[0], host = m[2], rest = m[3] || '';
    if (!map.has(full)) map.set(full, `${origin}/p/${host}${rest}`);
  }
  for (const [from, to] of map) html = html.split(from).join(to);
  html = html.replace(
    /(src|href)=["'](\/(?:playerkys|js|player|css)[^"']*)["']/gi,
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
    .replace(/DisableDevtool\s*\(\s*\{[\s\S]*?\}\s*\)\s*;?/gi, '');

  const bad = ['tynt\\.com', 'player-popunder', 'waust\\.at', 'acscdn\\.com', 'doubleclick\\.net', 'googlesyndication\\.com'];
  for (const d of bad) {
    html = html.replace(new RegExp(`<script[^>]*src=["'][^"']*${d}[^"']*["'][^>]*>[\\s\\S]*?<\\/script>`, 'gi'), '');
    html = html.replace(new RegExp(`<script[^>]*src=["'][^"']*${d}[^"']*["'][^>]*\\/?>`, 'gi'), '');
  }
  return html;
}