const BASE = 'https://mgeb.lat';

module.exports = async function handler(req, res) {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(String(id))) {
    return res.status(400).send('Use /me/filme/{tmdb_id}');
  }

  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  try {
    const pageRes = await fetch(`${BASE}/embed/${id}`, {
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        Referer: `${BASE}/`,
      },
      redirect: 'follow',
    });

    const html = await pageRes.text();

    if (!pageRes.ok || /Just a moment/i.test(html) || /cf-mitigated/i.test(html)) {
      return res
        .status(502)
        .send(
          'MegaEmbed bloqueou o fetch (Cloudflare challenge). Tenta de novo ou usa RedeFlix.\n\nStatus: ' +
            pageRes.status
        );
    }

    const sources = parseSources(html);
    const picked = pickSource(sources);

    if (!picked || !picked.file) {
      return res.status(404).send('Nenhuma fonte de vídeo encontrada no embed.');
    }

    // http:// → https:// quando possível (evita mixed content)
    let videoUrl = picked.file;
    if (videoUrl.startsWith('http://')) {
      videoUrl = 'https://' + videoUrl.slice('http://'.length);
    }

    return sendPlayer(res, videoUrl, html, id, picked.type);
  } catch (e) {
    return res.status(500).send('Erro: ' + e.message);
  }
};

function parseSources(html) {
  const m = html.match(/var\s+sources\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  try {
    return Function('return (' + m[1] + ')')();
  } catch (e) {
    return [];
  }
}

function pickSource(sources) {
  if (!Array.isArray(sources) || !sources.length) return null;

  const ok = sources.filter((s) => s && s.file && !s.ipLocked);

  // 1) mp4 sem ipLocked
  let s = ok.find((x) => String(x.type).toLowerCase() === 'mp4');
  if (s) return s;

  // 2) hls sem ipLocked
  s = ok.find((x) => /hls|m3u8/i.test(String(x.type)) || /\.m3u8/i.test(x.file));
  if (s) return s;

  // 3) qualquer sem ipLocked
  if (ok.length) return ok[0];

  // 4) último recurso: primeira fonte (pode falhar se ipLocked)
  return sources[0];
}

function pickTitle(html, id) {
  let m = html.match(/var\s+title\s*=\s*["']([^"']+)["']/);
  if (m && m[1] && !/blocked/i.test(m[1])) return m[1].trim();
  m = html.match(/<title>([^<]+)<\/title>/i);
  if (m && m[1] && !/blocked/i.test(m[1])) return m[1].trim();
  return 'Filme ' + id;
}

function pickPoster(html) {
  const m =
    html.match(/var\s+poster\s*=\s*["']([^"']+)["']/) ||
    html.match(/content="(https:\/\/image\.tmdb\.org[^"]+)"/);
  return m ? m[1].replace(/\\\//g, '/') : '';
}

function sendPlayer(res, videoUrl, html, id, typeHint) {
  const title = pickTitle(html, id);
  const poster = pickPoster(html);
  const isHls =
    /hls|m3u8/i.test(String(typeHint || '')) || /\.m3u8(\?|$)/i.test(videoUrl);

  const page = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${isHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.8"></script>' : ''}
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  #wrap{position:fixed;inset:0;background:#000}
  video{width:100%;height:100%;object-fit:contain;background:#000}
  .bar{position:absolute;left:0;right:0;bottom:0;padding:12px 16px;background:linear-gradient(transparent,rgba(0,0,0,.85));color:#fff;font:14px system-ui;display:flex;gap:10px;align-items:center;opacity:0;transition:.25s}
  #wrap:hover .bar{opacity:1}
  .bar span{opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>
</head>
<body>
<div id="wrap">
  <video id="v" controls autoplay playsinline ${poster ? `poster="${escapeHtml(poster)}"` : ''}></video>
  <div class="bar"><span>${escapeHtml(title)}</span></div>
</div>
<script>
(function(){
  var url = ${JSON.stringify(videoUrl)};
  var video = document.getElementById('v');
  var isHls = ${isHls ? 'true' : 'false'};
  if (isHls && window.Hls && Hls.isSupported()) {
    var hls = new Hls({ enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    video.src = url;
  }
  video.play().catch(function(){});
})();
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).send(page);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
