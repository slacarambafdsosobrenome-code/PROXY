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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
${isHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js"><\\/script>' : ''}
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:Roboto,Arial,sans-serif;color:#fff;-webkit-tap-highlight-color:transparent;user-select:none}
:root{--mt-red:#f00;--mt-red-soft:rgba(255,0,0,.85)}
#app{position:fixed;inset:0;background:#000;cursor:none}
#app.show-ui{cursor:default}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:2}
/* poster blur backdrop */
.backdrop{position:absolute;inset:0;z-index:1;background:#000 center/cover no-repeat;filter:blur(24px) brightness(.35);transform:scale(1.08);opacity:0;transition:opacity .4s}
#app:not(.started) .backdrop{opacity:1}
/* YouTube-style SVG loader */
.loader{position:absolute;top:50%;left:50%;width:70px;height:70px;margin:-35px 0 0 -35px;z-index:100;display:none;animation:spin 1.4s linear infinite}
#app.loading .loader{display:block}
.loader circle{stroke:#fff;stroke-linecap:butt;fill:none;stroke-width:4;animation:dash 1.4s ease-in-out infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes dash{0%{stroke-dasharray:1 200;stroke-dashoffset:0}50%{stroke-dasharray:100 200;stroke-dashoffset:-15}100%{stroke-dasharray:100 200;stroke-dashoffset:-125}}
/* center play */
.center{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;pointer-events:none}
.center button{pointer-events:auto;width:68px;height:68px;border-radius:50%;border:none;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transform:scale(.92);transition:opacity .25s,transform .2s,background .15s}
#app.show-ui:not(.playing) .center button,
#app.paused .center button{opacity:1;transform:scale(1)}
.center button:hover{background:var(--mt-red-soft);transform:scale(1.06)}
.center svg{width:30px;height:30px;margin-left:3px;fill:currentColor}
/* gradients */
.g-top,.g-bot{position:absolute;left:0;right:0;pointer-events:none;opacity:0;transition:opacity .3s;z-index:10}
#app.show-ui .g-top,#app.show-ui .g-bot,#app.paused .g-top,#app.paused .g-bot{opacity:1}
.g-top{top:0;height:110px;background:linear-gradient(to bottom,rgba(0,0,0,.7),transparent)}
.g-bot{bottom:0;height:150px;background:linear-gradient(to top,rgba(0,0,0,.85),transparent)}
/* top title */
.top{position:absolute;top:0;left:0;right:0;padding:16px 20px;z-index:30;opacity:0;transform:translateY(-6px);transition:opacity .3s,transform .3s}
#app.show-ui .top,#app.paused .top{opacity:1;transform:none}
.top h1{font-size:15px;font-weight:500;text-shadow:0 1px 4px rgba(0,0,0,.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* pause info card (estilo MegaTube) */
.pause-card{position:absolute;left:20px;bottom:90px;z-index:25;max-width:min(480px,70vw);opacity:0;pointer-events:none;transform:translateY(8px);transition:opacity .3s,transform .3s}
#app.paused.show-ui .pause-card{opacity:1;transform:none;pointer-events:auto}
.pause-card .meta{font-size:12px;font-weight:600;color:rgba(255,255,255,.75);margin-bottom:6px;letter-spacing:.3px}
.pause-card .name{font-size:22px;font-weight:700;margin-bottom:8px;text-shadow:0 2px 8px rgba(0,0,0,.7)}
.pause-card .desc{font-size:13px;line-height:1.5;color:rgba(255,255,255,.8);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 1px 4px rgba(0,0,0,.7)}
/* controls */
.controls{position:absolute;left:0;right:0;bottom:0;padding:0 12px 8px;z-index:40;opacity:0;pointer-events:none;transition:opacity .3s}
#app.show-ui .controls,#app.paused .controls{opacity:1;pointer-events:auto}
/* progress YouTube thin */
.prog{width:100%;height:28px;display:flex;align-items:flex-end;cursor:pointer;position:relative;margin-bottom:2px}
.track{width:100%;height:3px;background:rgba(255,255,255,.2);position:relative;transition:height .1s}
.prog:hover .track{height:5px}
.buf{position:absolute;left:0;top:0;bottom:0;width:0;background:rgba(255,255,255,.28)}
.fill{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--mt-red);z-index:1}
.hover{position:absolute;left:0;top:0;bottom:0;width:0;background:rgba(255,255,255,.22);display:none;z-index:0}
.prog:hover .hover{display:block}
.thumb{position:absolute;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;background:var(--mt-red);left:0;opacity:0;transform:scale(.5);transition:opacity .1s,transform .1s;z-index:2}
.prog:hover .thumb{opacity:1;transform:scale(1)}
.row{display:flex;align-items:center;gap:2px;padding-top:2px}
.row .sp{flex:1}
.btn{background:none;border:none;color:#fff;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .15s}
.btn:hover{background:rgba(255,255,255,.12)}
.btn svg{width:22px;height:22px;fill:currentColor}
.time{font-size:13px;font-variant-numeric:tabular-nums;opacity:.92;padding:0 8px;min-width:96px}
.vol{display:flex;align-items:center}
.vol input{width:0;opacity:0;transition:width .2s,opacity .2s;accent-color:var(--mt-red);cursor:pointer}
.vol:hover input{width:70px;opacity:1}
@media(max-width:640px){
  .top{padding:12px 14px}.top h1{font-size:14px}
  .controls{padding:0 8px 6px}
  .btn{width:36px;height:36px}
  .vol:hover input{width:0;opacity:0}
  .pause-card{left:12px;bottom:78px;max-width:85vw}
  .pause-card .name{font-size:18px}
  .time{min-width:78px;font-size:12px}
}
</style>
</head>
<body>
<div id="app" class="loading show-ui">
  <div class="backdrop" id="backdrop"></div>
  <video id="v" playsinline preload="auto"></video>
  <svg class="loader" viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"></circle></svg>
  <div class="g-top"></div>
  <div class="g-bot"></div>
  <div class="top"><h1>${escapeHtml(title)}</h1></div>
  <div class="center">
    <button type="button" id="bigPlay" aria-label="Play">
      <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    </button>
  </div>
  <div class="pause-card">
    <div class="meta">AGORA</div>
    <div class="name">${escapeHtml(title)}</div>
  </div>
  <div class="controls">
    <div class="prog" id="prog">
      <div class="track">
        <div class="hover" id="hover"></div>
        <div class="buf" id="buf"></div>
        <div class="fill" id="fill"></div>
      </div>
      <div class="thumb" id="thumb"></div>
    </div>
    <div class="row">
      <button class="btn" id="btnPlay" aria-label="Play">
        <svg id="iPlay" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        <svg id="iPause" viewBox="0 0 24 24" style="display:none"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>
      </button>
      <button class="btn" id="btnBack" title="-10s" aria-label="-10s">
        <svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C20.08 11.03 16.61 8 12.5 8z"/></svg>
      </button>
      <button class="btn" id="btnFwd" title="+10s" aria-label="+10s">
        <svg viewBox="0 0 24 24"><path d="M6 13c0-2.75 2.25-5 5-5h2V6l4 4-4 4v-2h-2c-1.65 0-3 1.35-3 3s1.35 3 3 3h2v2h-2c-2.76 0-5-2.24-5-5zm13-5v2h2c.55 0 1 .45 1 1v2h-2v2h2v2h-2c-.55 0-1-.45-1-1v-2h-2v-2h2v-2h-2V8h5z"/></svg>
      </button>
      <div class="vol">
        <button class="btn" id="btnMute" aria-label="Mute">
          <svg id="iVol" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          <svg id="iMute" viewBox="0 0 24 24" style="display:none"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
        </button>
        <input id="vol" type="range" min="0" max="1" step="0.05" value="1">
      </div>
      <div class="time"><span id="cur">0:00</span> / <span id="dur">0:00</span></div>
      <div class="sp"></div>
      <button class="btn" id="btnFs" aria-label="Fullscreen">
        <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
      </button>
    </div>
  </div>
</div>
<script>
(function(){
  var url=${JSON.stringify(videoUrl)};
  var poster=${JSON.stringify(poster)};
  var video=document.getElementById('v');
  var app=document.getElementById('app');
  var fill=document.getElementById('fill');
  var buf=document.getElementById('buf');
  var thumb=document.getElementById('thumb');
  var hover=document.getElementById('hover');
  var cur=document.getElementById('cur');
  var dur=document.getElementById('dur');
  var hideT=null;
  if(poster){
    document.getElementById('backdrop').style.backgroundImage='url('+JSON.stringify(poster)+')';
    video.poster=poster;
  }
  function fmt(t){
    if(!isFinite(t))return '0:00';
    t=Math.max(0,Math.floor(t));
    var h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60;
    if(h)return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    return m+':'+String(s).padStart(2,'0');
  }
  function showUI(){
    app.classList.add('show-ui');
    clearTimeout(hideT);
    if(!video.paused){
      hideT=setTimeout(function(){app.classList.remove('show-ui');},2800);
    }
  }
  function toggle(){
    if(video.paused)video.play().catch(function(){});
    else video.pause();
  }
  function icons(){
    var on=!video.paused;
    app.classList.toggle('playing',on);
    app.classList.toggle('paused',!on);
    document.getElementById('iPlay').style.display=on?'none':'block';
    document.getElementById('iPause').style.display=on?'block':'none';
  }
  if(/\\.m3u8(\\?|$)/i.test(url)&&window.Hls&&Hls.isSupported()){
    var hls=new Hls({enableWorker:true});
    hls.loadSource(url);
    hls.attachMedia(video);
  }else video.src=url;
  video.addEventListener('play',function(){app.classList.add('started');icons();});
  video.addEventListener('pause',function(){icons();showUI();});
  video.addEventListener('waiting',function(){app.classList.add('loading');});
  video.addEventListener('playing',function(){app.classList.remove('loading');});
  video.addEventListener('canplay',function(){app.classList.remove('loading');});
  video.addEventListener('loadedmetadata',function(){dur.textContent=fmt(video.duration);});
  video.addEventListener('timeupdate',function(){
    var d=video.duration||0,p=d?(video.currentTime/d)*100:0;
    fill.style.width=p+'%';thumb.style.left=p+'%';
    cur.textContent=fmt(video.currentTime);
    if(video.buffered.length&&d){
      buf.style.width=((video.buffered.end(video.buffered.length-1)/d)*100)+'%';
    }
  });
  document.getElementById('btnPlay').onclick=toggle;
  document.getElementById('bigPlay').onclick=toggle;
  video.addEventListener('click',toggle);
  document.getElementById('btnBack').onclick=function(){video.currentTime=Math.max(0,video.currentTime-10);};
  document.getElementById('btnFwd').onclick=function(){video.currentTime=Math.min(video.duration||0,video.currentTime+10);};
  document.getElementById('btnMute').onclick=function(){
    video.muted=!video.muted;
    document.getElementById('iVol').style.display=video.muted?'none':'block';
    document.getElementById('iMute').style.display=video.muted?'block':'none';
  };
  document.getElementById('vol').oninput=function(e){
    video.volume=parseFloat(e.target.value);
    video.muted=video.volume===0;
  };
  document.getElementById('btnFs').onclick=function(){
    if(!document.fullscreenElement)(app.requestFullscreen||app.webkitRequestFullscreen).call(app);
    else(document.exitFullscreen||document.webkitExitFullscreen).call(document);
  };
  var prog=document.getElementById('prog');
  function seek(e){
    var r=prog.getBoundingClientRect();
    var x=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
    if(video.duration)video.currentTime=x*video.duration;
  }
  prog.addEventListener('click',seek);
  prog.addEventListener('mousemove',function(e){
    var r=prog.getBoundingClientRect();
    var x=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
    hover.style.width=(x*100)+'%';
  });
  app.addEventListener('mousemove',showUI);
  app.addEventListener('touchstart',showUI,{passive:true});
  showUI();
  document.addEventListener('keydown',function(e){
    if(e.code==='Space'){e.preventDefault();toggle();}
    if(e.code==='ArrowRight')video.currentTime=Math.min(video.duration||0,video.currentTime+10);
    if(e.code==='ArrowLeft')video.currentTime=Math.max(0,video.currentTime-10);
    if(e.code==='KeyF')document.getElementById('btnFs').click();
    if(e.code==='KeyM')document.getElementById('btnMute').click();
    showUI();
  });
  video.play().catch(function(){app.classList.add('paused');showUI();});
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
