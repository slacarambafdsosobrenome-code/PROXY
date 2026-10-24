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
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${isHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7"></script>' : ''}
<style>
  :root {
    --accent: #e50914;
    --accent-soft: rgba(229, 9, 20, 0.85);
    --bar: rgba(255,255,255,0.35);
    --bar-bg: rgba(255,255,255,0.18);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%;
    background: #000;
    color: #fff;
    font-family: "Netflix Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
    overflow: hidden;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }
  #player {
    position: fixed; inset: 0;
    background: #000;
    cursor: none;
  }
  #player.show-cursor { cursor: default; }
  #player.show-controls { cursor: default; }
  video {
    width: 100%; height: 100%;
    object-fit: contain;
    background: #000;
    display: block;
  }
  /* gradientes */
  .shade-top, .shade-bottom {
    position: absolute; left: 0; right: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity .3s ease;
  }
  #player.show-controls .shade-top,
  #player.show-controls .shade-bottom { opacity: 1; }
  .shade-top {
    top: 0; height: 120px;
    background: linear-gradient(to bottom, rgba(0,0,0,.75), transparent);
  }
  .shade-bottom {
    bottom: 0; height: 160px;
    background: linear-gradient(to top, rgba(0,0,0,.85) 10%, transparent);
  }
  /* título */
  .top-bar {
    position: absolute; top: 0; left: 0; right: 0;
    padding: 18px 24px;
    display: flex; align-items: center; gap: 14px;
    opacity: 0;
    transform: translateY(-8px);
    transition: opacity .3s ease, transform .3s ease;
    z-index: 5;
  }
  #player.show-controls .top-bar {
    opacity: 1;
    transform: translateY(0);
  }
  .top-bar .title {
    font-size: 16px;
    font-weight: 600;
    text-shadow: 0 1px 4px rgba(0,0,0,.8);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* play central */
  .center-play {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    z-index: 4;
    pointer-events: none;
  }
  .center-play button {
    pointer-events: auto;
    width: 72px; height: 72px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,.85);
    background: rgba(0,0,0,.35);
    backdrop-filter: blur(6px);
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: transform .15s ease, background .15s ease, opacity .3s ease;
    opacity: 0;
    transform: scale(.9);
  }
  #player.show-controls:not(.playing) .center-play button,
  #player.paused .center-play button {
    opacity: 1;
    transform: scale(1);
  }
  .center-play button:hover {
    background: rgba(229,9,20,.85);
    border-color: #fff;
    transform: scale(1.06);
  }
  .center-play svg { width: 28px; height: 28px; margin-left: 3px; }
  /* controles inferiores */
  .controls {
    position: absolute; left: 0; right: 0; bottom: 0;
    padding: 0 16px 14px;
    z-index: 6;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity .3s ease, transform .3s ease;
  }
  #player.show-controls .controls {
    opacity: 1;
    transform: translateY(0);
  }
  /* progress */
  .progress-wrap {
    position: relative;
    height: 16px;
    display: flex; align-items: center;
    cursor: pointer;
    margin-bottom: 8px;
  }
  .progress-bg {
    position: absolute; left: 0; right: 0;
    height: 4px;
    background: var(--bar-bg);
    border-radius: 2px;
    transition: height .12s ease;
  }
  .progress-wrap:hover .progress-bg { height: 6px; }
  .progress-buf {
    position: absolute; left: 0; top: 0; bottom: 0;
    background: rgba(255,255,255,.28);
    border-radius: 2px;
    width: 0%;
  }
  .progress-fill {
    position: absolute; left: 0; top: 0; bottom: 0;
    background: var(--accent);
    border-radius: 2px;
    width: 0%;
  }
  .progress-knob {
    position: absolute;
    top: 50%;
    width: 14px; height: 14px;
    margin-top: -7px; margin-left: -7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px rgba(229,9,20,.25);
    opacity: 0;
    transform: scale(.6);
    transition: opacity .12s ease, transform .12s ease;
    left: 0%;
  }
  .progress-wrap:hover .progress-knob {
    opacity: 1;
    transform: scale(1);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .row .spacer { flex: 1; }
  .btn {
    background: none;
    border: none;
    color: #fff;
    width: 40px; height: 40px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: background .15s ease, transform .1s ease;
  }
  .btn:hover { background: rgba(255,255,255,.12); }
  .btn:active { transform: scale(.92); }
  .btn svg { width: 22px; height: 22px; fill: currentColor; }
  .time {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    opacity: .9;
    padding: 0 6px;
    min-width: 90px;
  }
  /* volume */
  .vol-wrap {
    display: flex; align-items: center;
    gap: 4px;
  }
  .vol-slider {
    width: 0;
    overflow: hidden;
    transition: width .2s ease;
  }
  .vol-wrap:hover .vol-slider { width: 80px; }
  .vol-slider input {
    width: 80px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  /* loading */
  .loader {
    position: absolute; inset: 0;
    display: none;
    align-items: center; justify-content: center;
    z-index: 3;
    background: rgba(0,0,0,.25);
  }
  #player.loading .loader { display: flex; }
  .spinner {
    width: 48px; height: 48px;
    border: 3px solid rgba(255,255,255,.2);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 640px) {
    .top-bar { padding: 12px 14px; }
    .top-bar .title { font-size: 14px; }
    .controls { padding: 0 10px 10px; }
    .btn { width: 36px; height: 36px; }
    .vol-wrap:hover .vol-slider { width: 0; }
    .time { min-width: 70px; font-size: 12px; }
  }
</style>
</head>
<body>
<div id="player" class="loading show-controls">
  <video id="v" playsinline preload="auto" ${poster ? `poster="${escapeHtml(poster)}"` : ''}></video>
  <div class="shade-top"></div>
  <div class="shade-bottom"></div>
  <div class="top-bar">
    <div class="title">${escapeHtml(title)}</div>
  </div>
  <div class="center-play">
    <button type="button" id="bigPlay" aria-label="Play">
      <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    </button>
  </div>
  <div class="loader"><div class="spinner"></div></div>
  <div class="controls">
    <div class="progress-wrap" id="progress">
      <div class="progress-bg">
        <div class="progress-buf" id="buf"></div>
        <div class="progress-fill" id="fill"></div>
      </div>
      <div class="progress-knob" id="knob"></div>
    </div>
    <div class="row">
      <button class="btn" id="btnPlay" aria-label="Play/Pause">
        <svg id="iconPlay" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        <svg id="iconPause" viewBox="0 0 24 24" style="display:none"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
      </button>
      <button class="btn" id="btnBack" aria-label="-10s" title="-10s">
        <svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
      </button>
      <button class="btn" id="btnFwd" aria-label="+10s" title="+10s">
        <svg viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg>
      </button>
      <div class="vol-wrap">
        <button class="btn" id="btnMute" aria-label="Mute">
          <svg id="iconVol" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          <svg id="iconMute" viewBox="0 0 24 24" style="display:none"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
        </button>
        <div class="vol-slider"><input id="vol" type="range" min="0" max="1" step="0.05" value="1"></div>
      </div>
      <div class="time"><span id="cur">0:00</span> / <span id="dur">0:00</span></div>
      <div class="spacer"></div>
      <button class="btn" id="btnFs" aria-label="Fullscreen">
        <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
      </button>
    </div>
  </div>
</div>
<script>
(function () {
  var url = ${JSON.stringify(videoUrl)};
  var video = document.getElementById('v');
  var root = document.getElementById('player');
  var fill = document.getElementById('fill');
  var buf = document.getElementById('buf');
  var knob = document.getElementById('knob');
  var curEl = document.getElementById('cur');
  var durEl = document.getElementById('dur');
  var hideTimer = null;
  function fmt(t) {
    if (!isFinite(t)) return '0:00';
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    return m + ':' + String(s).padStart(2,'0');
  }
  function showControls() {
    root.classList.add('show-controls', 'show-cursor');
    clearTimeout(hideTimer);
    if (!video.paused) {
      hideTimer = setTimeout(function () {
        root.classList.remove('show-controls', 'show-cursor');
      }, 2800);
    }
  }
  function togglePlay() {
    if (video.paused) video.play().catch(function(){});
    else video.pause();
  }
  function updatePlayIcons() {
    var playing = !video.paused;
    root.classList.toggle('playing', playing);
    root.classList.toggle('paused', !playing);
    document.getElementById('iconPlay').style.display = playing ? 'none' : 'block';
    document.getElementById('iconPause').style.display = playing ? 'block' : 'none';
  }
  // media source
  if (/\\.m3u8(\\?|$)/i.test(url) && window.Hls && Hls.isSupported()) {
    var hls = new Hls({ enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    video.src = url;
  }
  video.addEventListener('play', updatePlayIcons);
  video.addEventListener('pause', function () {
    updatePlayIcons();
    showControls();
  });
  video.addEventListener('waiting', function () { root.classList.add('loading'); });
  video.addEventListener('playing', function () { root.classList.remove('loading'); });
  video.addEventListener('canplay', function () { root.classList.remove('loading'); });
  video.addEventListener('loadedmetadata', function () {
    durEl.textContent = fmt(video.duration);
  });
  video.addEventListener('timeupdate', function () {
    var d = video.duration || 0;
    var p = d ? (video.currentTime / d) * 100 : 0;
    fill.style.width = p + '%';
    knob.style.left = p + '%';
    curEl.textContent = fmt(video.currentTime);
    if (video.buffered.length) {
      var b = (video.buffered.end(video.buffered.length - 1) / d) * 100;
      buf.style.width = b + '%';
    }
  });
  document.getElementById('btnPlay').onclick = togglePlay;
  document.getElementById('bigPlay').onclick = togglePlay;
  video.addEventListener('click', togglePlay);
  document.getElementById('btnBack').onclick = function () {
    video.currentTime = Math.max(0, video.currentTime - 10);
  };
  document.getElementById('btnFwd').onclick = function () {
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
  };
  document.getElementById('btnMute').onclick = function () {
    video.muted = !video.muted;
    document.getElementById('iconVol').style.display = video.muted ? 'none' : 'block';
    document.getElementById('iconMute').style.display = video.muted ? 'block' : 'none';
  };
  document.getElementById('vol').oninput = function (e) {
    video.volume = parseFloat(e.target.value);
    video.muted = video.volume === 0;
  };
  document.getElementById('btnFs').onclick = function () {
    if (!document.fullscreenElement) root.requestFullscreen?.() || root.webkitRequestFullscreen?.();
    else document.exitFullscreen?.();
  };
  // seek
  var progress = document.getElementById('progress');
  function seek(e) {
    var rect = progress.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    x = Math.min(1, Math.max(0, x));
    if (video.duration) video.currentTime = x * video.duration;
  }
  progress.addEventListener('click', seek);
  // mouse / touch show controls
  root.addEventListener('mousemove', showControls);
  root.addEventListener('touchstart', showControls, { passive: true });
  showControls();
  // keyboard
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
    if (e.code === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 10);
    if (e.code === 'KeyF') document.getElementById('btnFs').click();
    if (e.code === 'KeyM') document.getElementById('btnMute').click();
    showControls();
  });
  video.play().catch(function () {
    root.classList.add('paused');
    showControls();
  });
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
