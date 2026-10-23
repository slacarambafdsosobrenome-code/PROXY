const BASE = 'https://redeflixapi.store';

module.exports = async function handler(req, res) {
  const { id } = req.query;

  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).send('Use /filme/{tmdb_id}');
  }

  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  try {
    // 1) busca a página (gera o ticket)
    const pageRes = await fetch(`${BASE}/filme/${id}`, {
      headers: {
        'User-Agent': ua,
        Accept: 'text/html',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        Referer: `${BASE}/`,
      },
      redirect: 'follow',
    });

    if (!pageRes.ok) {
      return res.status(502).send(`Erro ao buscar filme: ${pageRes.status}`);
    }

    const html = await pageRes.text();

    // 2) extrai ticket rápido
    const fastMatch = html.match(/fastLaunchTickets\s*=\s*(\{[\s\S]*?\});/);
    let ticket = null;
    if (fastMatch) {
      try {
        const obj = Function('return (' + fastMatch[1] + ')')();
        ticket = obj.default || obj.legendado || null;
      } catch (e) {}
    }

    // fallback: playbackResolveTicket + resolve
    if (!ticket) {
      const pr = html.match(/playbackResolveTicket\s*=\s*"([^"]+)"/);
      if (pr) {
        const resolveRes = await fetch(`${BASE}/playback-resolve.php`, {
          method: 'POST',
          headers: {
            'User-Agent': ua,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Referer: `${BASE}/filme/${id}`,
            Origin: BASE,
            'X-Requested-With': 'RedeFlixPlayer',
          },
          body: JSON.stringify({ ticket: pr[1], server: 'default' }),
        });
        const resolved = await resolveRes.json().catch(() => ({}));
        ticket = resolved.launchTicket || null;
        if (resolved.url) {
          return sendPlayer(res, resolved.url, html, id);
        }
      }
    }

    if (!ticket) {
      return res.status(404).send('Sem ticket de reprodução para este filme.');
    }

    // 3) troca ticket pelo link do vídeo (MESMA request = mesmo "dispositivo")
    const srcRes = await fetch(`${BASE}/playerkys/source.php`, {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Referer: `${BASE}/playerkys/index.html`,
        Origin: BASE,
        'X-Requested-With': 'RedeFlixPlayer',
      },
      body: JSON.stringify({ ticket }),
    });

    const srcJson = await srcRes.json().catch(() => ({}));

    if (!srcRes.ok || !srcJson.url) {
      return res
        .status(403)
        .send(
          'Falha ao autorizar vídeo: ' +
            (srcJson.error || srcRes.status) +
            '\n\nTente de novo em alguns segundos.'
        );
    }

    return sendPlayer(res, srcJson.url, html, id);
  } catch (e) {
    return res.status(500).send('Erro: ' + e.message);
  }
};

function pickTitle(html, id) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (m) return m[1].replace(/\s*-\s*RedeFlixApi.*/i, '').trim();
  return 'Filme ' + id;
}

function pickPoster(html) {
  const m =
    html.match(/playerPoster\s*=\s*"([^"]+)"/) ||
    html.match(/content="(https:\/\/image\.tmdb\.org[^"]+)"/);
  return m ? m[1] : '';
}

function sendPlayer(res, videoUrl, html, id) {
  const title = pickTitle(html, id);
  const poster = pickPoster(html);
  const isHls = /\.m3u8(\?|$)/i.test(videoUrl);

  const page = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
  #wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000}
  video{width:100%;height:100%;max-height:100%;background:#000;outline:none}
</style>
${isHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7"></script>' : ''}
</head>
<body>
<div id="wrap">
  <video id="v" controls autoplay playsinline ${poster ? `poster="${escapeHtml(poster)}"` : ''}></video>
</div>
<script>
(function(){
  var url = ${JSON.stringify(videoUrl)};
  var video = document.getElementById('v');
  var isHls = /\\.m3u8(\\?|$)/i.test(url);
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
