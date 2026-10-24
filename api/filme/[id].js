// ============================================================================
//  PipocaFlix • Player de filmes  (Vercel / Node)
//  Rota: /filme/{tmdb_id}
// ============================================================================
const BASE = 'https://redeflixapi.store';

// ---- Ajustes rápidos -------------------------------------------------------
const BRAND = 'PipocaFlix';
const ACCENT = '#ff2a2a'; // cor de destaque (barra, botões, loader)
const SLEEP_IMG = 'https://i.ibb.co/GvwSZ1yM/transferir.png'; // imagem da pausa
const ERROR_IMG = 'https://i.pinimg.com/736x/20/d2/fd/20d2fdf6742140fd80973142ea36ceab.jpg'; // imagem do erro
const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js';
const NATIVE_HLS_FIRST = true; // true = usa HLS nativo (Safari/iOS) antes do hls.js
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ============================================================================
//  HANDLER
// ============================================================================
module.exports = async function handler(req, res) {
  const { id } = req.query;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).send('Use /filme/{tmdb_id}');
  }

  try {
    // 1) busca a página (gera o ticket)
    const pageRes = await fetch(`${BASE}/filme/${id}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        Referer: `${BASE}/`,
      },
      redirect: 'follow',
    });
    if (!pageRes.ok) {
      return sendError(res, 502, 'Não conseguimos abrir este filme agora.', 'Código ' + pageRes.status);
    }
    const html = await pageRes.text();

    // 2) extrai ticket rápido (sem executar código vindo de fora)
    const fast = extractTickets(html);
    let ticket = fast.default || fast.legendado || null;

    // fallback: playbackResolveTicket + resolve
    if (!ticket) {
      const pr = html.match(/playbackResolveTicket\s*=\s*"([^"]+)"/);
      if (pr) {
        const resolveRes = await fetch(`${BASE}/playback-resolve.php`, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
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
      return sendError(res, 404, 'Este filme ainda não tem reprodução disponível.', 'Sem ticket');
    }

    // 3) troca o ticket pelo link do vídeo (MESMA request = mesmo "dispositivo")
    const srcRes = await fetch(`${BASE}/playerkys/source.php`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
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
      return sendError(
        res,
        403,
        'Não foi possível autorizar o vídeo. Tente de novo em alguns segundos.',
        srcJson.error ? String(srcJson.error) : 'Código ' + srcRes.status
      );
    }
    return sendPlayer(res, srcJson.url, html, id);
  } catch (e) {
    console.error('[player]', e);
    return sendError(res, 500, 'Algo inesperado aconteceu ao carregar o filme.', 'Erro interno');
  }
};

// ============================================================================
//  HELPERS DO SERVIDOR
// ============================================================================
// Lê { default: "...", legendado: "..." } sem usar eval/Function.
function extractTickets(html) {
  const m = html.match(/fastLaunchTickets\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return {};
  const raw = m[1].replace(/\};?\s*$/, '}');
  try {
    return JSON.parse(raw);
  } catch (e) {
    /* não é JSON puro: cai no regex abaixo */
  }
  const out = {};
  const re = /["']?([A-Za-z_]\w*)["']?\s*:\s*["']([^"']+)["']/g;
  let k;
  while ((k = re.exec(raw))) out[k[1]] = k[2];
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function pickTitle(html, id) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  if (m) return decodeEntities(m[1].replace(/\s*-\s*RedeFlixApi.*/i, '').trim());
  return 'Filme ' + id;
}

function pickPoster(html) {
  const m =
    html.match(/playerPoster\s*=\s*"([^"]+)"/) ||
    html.match(/content="(https:\/\/image\.tmdb\.org[^"]+)"/);
  return m ? m[1] : '';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
//  TELA DE ERRO (servidor)
// ============================================================================
function sendError(res, status, message, code) {
  const page = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Algo deu errado • ${escapeHtml(BRAND)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#000;color:#fff;font-family:Roboto,system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
body{display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(ellipse at 50% 30%,#2a0d0f,#000 70%)}
.card{display:flex;flex-direction:column;align-items:center;gap:14px;max-width:420px;text-align:center;padding:26px 24px;border-radius:24px;background:rgba(20,20,20,.6);border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.6)}
.brand{font-weight:900;letter-spacing:.32em;font-size:12px;color:${ACCENT}}
img{width:min(300px,70vw);max-height:34vh;object-fit:cover;border-radius:16px}
h1{font-size:22px}
p{font-size:14px;line-height:1.5;color:rgba(255,255,255,.72)}
small{font-size:11px;color:rgba(255,255,255,.4)}
button{margin-top:4px;padding:12px 24px;border:0;border-radius:999px;background:${ACCENT};color:#fff;font-weight:700;font-size:14px;font-family:inherit;cursor:pointer}
button:hover{filter:brightness(1.12)}
button:focus-visible{outline:2px solid #fff;outline-offset:3px}
</style>
</head>
<body>
<div class="card" role="alert">
  <div class="brand">${escapeHtml(BRAND.toUpperCase())}</div>
  <img src="${ERROR_IMG}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
  <h1>Algo deu errado 😕</h1>
  <p>${escapeHtml(message)}</p>
  <button type="button" onclick="location.reload()" aria-label="Tentar novamente">Tentar novamente</button>
  <small>${escapeHtml(String(code || '').slice(0, 80))}</small>
</div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(page);
}

// ============================================================================
//  CSS DO PLAYER
// ============================================================================
const CSS = String.raw`
*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
:root{--glass:rgba(20,20,20,.55);--glass-line:rgba(255,255,255,.1);--ease:cubic-bezier(.2,.8,.2,1);color-scheme:dark}
html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:Roboto,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#fff;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
button:focus,[role=slider]:focus{outline:none}
button:focus-visible,[role=slider]:focus-visible,input:focus-visible{outline:2px solid #fff;outline-offset:2px;border-radius:10px}

#app{position:fixed;inset:0;background:#000;overflow:hidden;cursor:none}
#app.show-ui{cursor:default}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:transparent;z-index:2}

/* fundo borrado do poster (só antes de começar) */
.backdrop{position:absolute;inset:0;z-index:1;background:#000 center/cover no-repeat;filter:blur(22px) brightness(.38);transform:scale(1.12);opacity:0;visibility:hidden;transition:opacity .5s,visibility 0s .5s}
#app:not(.started) .backdrop{opacity:1;visibility:visible;transition-delay:0s}

/* camada de toques / cliques */
.tap{position:absolute;inset:0;z-index:5;touch-action:manipulation}

/* efeito do duplo toque ±10s */
.fx{position:absolute;top:0;bottom:0;width:32%;z-index:8;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;font-size:13px;font-weight:700;background:rgba(255,255,255,.14);opacity:0}
.fx.l{left:0;border-radius:0 100% 100% 0/0 50% 50% 0}
.fx.r{right:0;border-radius:100% 0 0 100%/50% 0 0 50%}
.fx.go{animation:fx .75s ease-out}
.fx svg{width:30px;height:30px;fill:#fff}
.fx.l svg{transform:scaleX(-1)}
@keyframes fx{0%{opacity:0}15%{opacity:1}75%{opacity:1}100%{opacity:0}}

/* gradientes + título */
.g-top,.g-bot{position:absolute;left:0;right:0;pointer-events:none;opacity:0;transition:opacity .3s;z-index:10}
.g-top{top:0;height:120px;background:linear-gradient(to bottom,rgba(0,0,0,.65),transparent)}
.g-bot{bottom:0;height:170px;background:linear-gradient(to top,rgba(0,0,0,.55),transparent)}
#app.show-ui .g-top,#app.show-ui .g-bot{opacity:1}
.top{position:absolute;top:0;left:0;right:0;padding:max(16px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) 16px max(20px,env(safe-area-inset-left));z-index:30;opacity:0;transform:translateY(-6px);transition:opacity .3s,transform .3s;pointer-events:none}
#app.show-ui .top{opacity:1;transform:none}
.top h1{font-size:15px;font-weight:500;text-shadow:0 1px 4px rgba(0,0,0,.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* PiP */
.pipnote{position:absolute;inset:0;z-index:12;display:none;align-items:center;justify-content:center;pointer-events:none;color:rgba(255,255,255,.7);font-size:15px;background:#000}
#app.pip .pipnote{display:flex}

/* palco central: cartão de pausa + botão grande */
.stage{position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:0 24px 90px;pointer-events:none;opacity:0;transition:opacity .35s;background:radial-gradient(ellipse at center,rgba(0,0,0,.62),rgba(0,0,0,.3) 75%)}
#app.sleepy .stage,#app.idle .stage,#app.ended .stage{opacity:1}
#app.errored .stage,#app.resuming .stage,#app.pip .stage{display:none}
.sleepy{display:none;flex-direction:column;align-items:center;gap:14px;text-align:center}
#app.sleepy .sleepy{display:flex;animation:rise .5s var(--ease) both}
.sleepy img{max-width:min(72vw,360px);max-height:min(34vh,260px);object-fit:contain;border-radius:18px;filter:drop-shadow(0 12px 30px rgba(0,0,0,.5))}
.sleepy p{font-size:15px;line-height:1.55;max-width:34ch;text-shadow:0 2px 10px rgba(0,0,0,.7)}
.sleepy p b{display:block;font-size:17px;margin-bottom:2px}
.big{pointer-events:none;width:68px;height:68px;border-radius:50%;background:rgba(20,20,20,.55);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;transition:transform .2s,background .2s;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.big:hover{background:var(--accent);transform:scale(1.08)}
.big svg{width:32px;height:32px;margin-left:3px;fill:#fff}
#app.sleepy .big,#app.idle .big,#app.ended .big{pointer-events:auto}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}

/* loader com a marca */
.loader{position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .25s,visibility 0s .25s}
#app.loading .loader{opacity:1;visibility:visible;transition-delay:0s}
.lbox{display:flex;flex-direction:column;align-items:center;gap:12px;padding:18px 26px;border-radius:22px}
#app.started .lbox{background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.brand{font-weight:900;letter-spacing:.34em;font-size:13px;color:var(--accent);text-indent:.34em}
#app.started .brand{display:none}
.pop{width:64px;height:64px;overflow:visible;animation:bob 1.6s ease-in-out infinite}
.pop .mound circle{fill:#ffe9a8;stroke:#f1c25e;stroke-width:1.2}
.pk{fill:#fff3c4;stroke:#f1c25e;stroke-width:1;transform-box:fill-box;transform-origin:center;opacity:0;animation:pk 1.5s ease-out infinite}
.pk.b{animation-delay:.5s;--dx:0px}
.pk.a{animation-delay:0s;--dx:-12px}
.pk.c{animation-delay:1s;--dx:12px}
.msg{font-size:14px;color:rgba(255,255,255,.88);min-height:20px;transition:opacity .16s;text-align:center}
.msg.swap{opacity:0}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes pk{0%{transform:translate(0,6px) scale(.4);opacity:0}15%{opacity:1}100%{transform:translate(var(--dx,0),-28px) rotate(90deg) scale(1);opacity:0}}

/* barra de controles em vidro */
.controls{position:absolute;left:50%;bottom:max(14px,env(safe-area-inset-bottom));z-index:70;width:min(940px,calc(100% - 28px));padding:4px 12px 8px;border-radius:20px;background:var(--glass);-webkit-backdrop-filter:blur(16px) saturate(150%);backdrop-filter:blur(16px) saturate(150%);border:1px solid var(--glass-line);box-shadow:0 12px 40px rgba(0,0,0,.45);opacity:0;pointer-events:none;transform:translate(-50%,12px);transition:opacity .3s var(--ease),transform .3s var(--ease)}
#app.show-ui .controls{opacity:1;pointer-events:auto;transform:translate(-50%,0)}
#app.resuming .controls,#app.errored .controls{opacity:0;pointer-events:none}
#app.soft .controls,#app.soft .top,#app.soft .g-top,#app.soft .g-bot{transition-duration:.9s}

/* barra de progresso */
.prog{position:relative;height:26px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.track{position:relative;width:100%;height:4px;border-radius:3px;background:rgba(255,255,255,.22);overflow:hidden;transition:height .12s}
.prog.drag .track{height:6px}
.buf,.fill,.hover{position:absolute;left:0;top:0;bottom:0;width:0}
.buf{background:rgba(255,255,255,.3)}
.fill{background:var(--accent);z-index:1}
.hover{display:none;background:rgba(255,255,255,.25)}
.thumb{position:absolute;top:50%;left:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:var(--accent);opacity:0;transform:scale(.4);transition:opacity .12s,transform .12s;pointer-events:none}
.prog.drag .thumb{opacity:1;transform:scale(1.15)}
.tip{position:absolute;bottom:30px;left:0;transform:translateX(-50%);padding:5px 10px;border-radius:10px;background:rgba(15,15,15,.9);border:1px solid var(--glass-line);font-size:12.5px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s}
.prog.drag .tip{opacity:1}
@media (hover:hover){
  .prog:hover .track{height:6px}
  .prog:hover .hover{display:block}
  .prog:hover .tip{opacity:1}
  .prog:hover .thumb{opacity:1;transform:scale(1)}
}

/* linha de botões */
.row{display:flex;align-items:center;gap:2px}
.row .sp{flex:1}
.btn{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,transform .15s;flex:none}
.btn:hover{background:rgba(255,255,255,.14)}
.btn:active{transform:scale(.92)}
.btn svg{width:24px;height:24px;fill:currentColor;transition:transform .25s}
.btn[aria-pressed=true],.btn[aria-expanded=true]{color:var(--accent)}
#btnSet[aria-expanded=true] svg{transform:rotate(45deg)}
#mph{stroke:currentColor;stroke-width:.5;stroke-linejoin:round}
.time{font-size:13px;font-variant-numeric:tabular-nums;opacity:.92;padding:0 8px;min-width:96px;white-space:nowrap}
.vol{display:flex;align-items:center}
.vol input{width:0;opacity:0;transition:width .2s,opacity .2s,margin .2s;accent-color:var(--accent);cursor:pointer;height:4px}
.vol:hover input,.vol:focus-within input{width:76px;opacity:1;margin:0 8px 0 2px}
.i-exit{display:none}
#app.fs .i-exit{display:block}
#app.fs .i-enter{display:none}

/* menu de configurações */
.setwrap{position:relative}
.menu{position:absolute;right:0;bottom:calc(100% + 46px);min-width:190px;padding:8px;border-radius:16px;background:rgba(22,22,22,.96);border:1px solid var(--glass-line);box-shadow:0 14px 40px rgba(0,0,0,.55);opacity:0;visibility:hidden;transform:translateY(8px) scale(.97);transform-origin:bottom right;transition:opacity .18s,transform .18s,visibility 0s .18s}
.menu.open{opacity:1;visibility:visible;transform:none;transition-delay:0s}
.menu h3{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.55);padding:6px 10px 8px}
.mi{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:9px 10px;border-radius:10px;font-size:14px;text-align:left}
.mi:hover{background:rgba(255,255,255,.1)}
.mi[aria-checked=true]{color:var(--accent);font-weight:700}
.mi svg{width:16px;height:16px;fill:currentColor;opacity:0}
.mi[aria-checked=true] svg{opacity:1}

/* mapa das cenas */
.scenes{position:absolute;top:0;right:0;bottom:0;width:min(440px,88vw);z-index:60;display:flex;flex-direction:column;background:rgba(14,14,14,.82);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border-left:1px solid var(--glass-line);transform:translateX(102%);visibility:hidden;transition:transform .35s var(--ease),visibility 0s .35s}
#app.scenes-open .scenes{transform:none;visibility:visible;transition-delay:0s}
.scenes header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:max(16px,env(safe-area-inset-top)) 12px 10px 18px}
.scenes h2{font-size:16px;font-weight:700}
.scenes .sub{font-size:12px;color:rgba(255,255,255,.55);margin-top:2px}
.grid{flex:1;overflow:auto;display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:6px 16px 130px;align-content:start;-webkit-overflow-scrolling:touch}
.sc{position:relative;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:linear-gradient(135deg,#1d1d1d,#2b2b2b);border:2px solid transparent;transition:transform .15s,border-color .15s}
.sc:hover{transform:scale(1.03)}
.sc.on{border-color:var(--accent)}
.sc canvas{position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity .35s}
.sc.has canvas{opacity:1}
.sc:not(.has)::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.07) 50%,transparent 70%);background-size:200% 100%;animation:sh 1.4s linear infinite}
.grid.done .sc:not(.has)::after{display:none}
.sc .t{position:absolute;left:6px;bottom:6px;z-index:1;padding:2px 7px;border-radius:7px;background:rgba(0,0,0,.72);font-size:11.5px;font-weight:600;font-variant-numeric:tabular-nums}
@keyframes sh{from{background-position:200% 0}to{background-position:-200% 0}}

/* cartão "continuar de onde parou" */
.resume,.err{position:absolute;inset:0;display:none;align-items:center;justify-content:center;padding:20px}
.resume{z-index:65}
#app.resuming .resume{display:flex}
.card{max-width:min(420px,100%);padding:22px 24px;border-radius:22px;background:rgba(18,18,18,.72);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid var(--glass-line);box-shadow:0 20px 60px rgba(0,0,0,.6);text-align:center;animation:rise .4s var(--ease) both}
.card h2{font-size:20px;margin-bottom:6px}
.card p{font-size:13.5px;color:rgba(255,255,255,.7);margin-bottom:18px;line-height:1.5}
.cta{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.pbtn,.gbtn{padding:11px 22px;border-radius:999px;font-weight:700;font-size:14px;transition:filter .15s,transform .15s,background .15s}
.pbtn{background:var(--accent);color:#fff}
.gbtn{background:rgba(255,255,255,.12)}
.pbtn:hover{filter:brightness(1.12)}
.gbtn:hover{background:rgba(255,255,255,.2)}
.pbtn:active,.gbtn:active{transform:scale(.97)}

/* tela de erro */
.err{z-index:95;background:rgba(0,0,0,.86);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
#app.errored .err{display:flex}
.err .card{display:flex;flex-direction:column;align-items:center;gap:12px}
.err .card p{margin:0}
.err img{width:min(300px,70vw);max-height:32vh;object-fit:cover;border-radius:16px}
.err small{font-size:11px;color:rgba(255,255,255,.4)}

/* aviso rápido */
.toast{position:absolute;top:max(64px,calc(env(safe-area-inset-top) + 56px));left:50%;z-index:90;transform:translate(-50%,-8px);padding:8px 16px;border-radius:999px;background:rgba(20,20,20,.72);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid var(--glass-line);font-size:13.5px;font-weight:500;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
.toast.on{opacity:1;transform:translate(-50%,0)}

/* modo cinema: só o filme */
#app.cinema .top,#app.cinema .g-top,#app.cinema .g-bot{opacity:0!important}
#app.cinema .controls{background:rgba(10,10,10,.42);box-shadow:none;width:min(720px,calc(100% - 28px))}
#app.cinema .sleepy{display:none!important}
#app.cinema .stage{background:none}

@media (max-width:640px){
  .top h1{font-size:14px}
  .controls{width:calc(100% - 20px);padding:2px 8px 6px;border-radius:18px}
  .btn{width:38px;height:38px}
  .btn svg{width:22px;height:22px}
  .vol,#btnBack,#btnFwd,#btnCinema{display:none}
  .time{min-width:0;font-size:12px;padding:0 6px}
}
@media (max-height:460px){
  .stage{gap:10px;padding-bottom:96px}
  .sleepy{gap:8px}
  .sleepy img{max-height:28vh}
  .sleepy p{font-size:13px}
  .big{width:54px;height:54px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
`;

// ============================================================================
//  JS DO PLAYER (roda no navegador)
//  Obs: sem crases e sem ${ } aqui dentro (é um String.raw).
// ============================================================================
const CLIENT_JS = String.raw`
(function(){
  'use strict';
  var C = window.__PF || {};
  function $(id){ return document.getElementById(id); }

  var app=$('app'), video=$('v'), controls=$('controls'), prog=$('prog'), fill=$('fill'), buf=$('buf'),
      hoverEl=$('hover'), thumbEl=$('thumb'), tip=$('tip'), curEl=$('cur'), durEl=$('dur'), msgEl=$('msg'),
      toastEl=$('toast'), btnPlay=$('btnPlay'), btnBig=$('bigPlay'), btnMute=$('btnMute'), volIn=$('vol'),
      btnFs=$('btnFs'), btnSet=$('btnSet'), menu=$('menu'), btnCinema=$('btnCinema'), btnScenes=$('btnScenes'),
      btnPip=$('btnPip'), btnCast=$('btnCast'), scenesEl=$('scenes'), grid=$('scGrid'), tapEl=$('tap'),
      fxL=$('fxL'), fxR=$('fxR'), mph=$('mph');

  var MSGS=['Preparando a sessão…','Ajustando o projetor…','Quase na primeira cena…'];
  var SPEEDS=[0.5,0.75,1,1.25,1.5,1.75,2];
  var SCENES=12;
  var KPOS='pf:pos:'+C.id, KVOL='pf:vol';

  var hls=null, started=false, dragging=false, dragRatio=0, menuOpen=false, scenesOpen=false, cinema=false;
  var hideT=0, sleepT=0, loadT=0, stallT=0, toastT=0, netTries=0, mediaTries=0, lastSec=-1, panelsClosedAt=0;
  var canHover = !!(window.matchMedia && window.matchMedia('(hover:hover)').matches);
  var savedPos=0, lastPT='mouse';

  // ---------- utilidades ----------
  function fmt(t){
    if(!isFinite(t)) return '0:00';
    t=Math.max(0,Math.floor(t));
    var h=Math.floor(t/3600), m=Math.floor((t%3600)/60), s=t%60;
    if(h) return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    return m+':'+String(s).padStart(2,'0');
  }
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
  function has(c){ return app.classList.contains(c); }
  function toast(t){
    toastEl.textContent=t; toastEl.classList.add('on');
    clearTimeout(toastT); toastT=setTimeout(function(){ toastEl.classList.remove('on'); },1700);
  }

  // ---------- ícone play/pause com morph ----------
  var PLAY =[12,26, 18.5,22, 18.5,14, 12,10,   18.5,22, 25,18, 25,18, 18.5,14];
  var PAUSE=[12,26, 16,26,   16,10,   12,10,   21,26,   25,26, 25,10, 21,10];
  function pathOf(a){
    return 'M'+a[0]+' '+a[1]+'L'+a[2]+' '+a[3]+'L'+a[4]+' '+a[5]+'L'+a[6]+' '+a[7]+'Z'+
           'M'+a[8]+' '+a[9]+'L'+a[10]+' '+a[11]+'L'+a[12]+' '+a[13]+'L'+a[14]+' '+a[15]+'Z';
  }
  var mCur=0, mFrom=0, mTo=0, mT0=0, mRaf=0;
  function mDraw(k){
    var a=[], i;
    for(i=0;i<16;i++) a.push(Math.round((PLAY[i]+(PAUSE[i]-PLAY[i])*k)*100)/100);
    mph.setAttribute('d', pathOf(a));
  }
  function morphTo(k){
    cancelAnimationFrame(mRaf);
    mFrom=mCur; mTo=k; mT0=performance.now();
    function step(now){
      var p=Math.min(1,(now-mT0)/200);
      var e=p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2;
      mCur=mFrom+(mTo-mFrom)*e;
      mDraw(mCur);
      if(p<1) mRaf=requestAnimationFrame(step);
    }
    mRaf=requestAnimationFrame(step);
  }

  // ---------- mensagens do loader (seguem o estado real) ----------
  var msgIdx=0, msgAt=Date.now(), msgT=0;
  function applyMsg(i){
    msgIdx=i; msgAt=Date.now(); msgEl.classList.add('swap');
    setTimeout(function(){ msgEl.textContent=MSGS[i]; msgEl.classList.remove('swap'); },160);
  }
  function setMsg(i,force){
    if(!force && !started && i<=msgIdx) return;
    if(i===msgIdx) return;
    clearTimeout(msgT);
    msgT=setTimeout(function(){ applyMsg(i); }, Math.max(0,1100-(Date.now()-msgAt)));
  }

  // ---------- visibilidade da interface ----------
  function uiLocked(){
    return video.paused || dragging || menuOpen || scenesOpen || has('resuming') || has('errored');
  }
  function showUI(){
    app.classList.add('show-ui');
    clearTimeout(hideT);
    if(!uiLocked()) hideT=setTimeout(hideUI, cinema?2000:2800);
  }
  function hideUI(){
    if(uiLocked()) return;
    if(canHover && controls.matches(':hover')){ hideT=setTimeout(hideUI,1200); return; }
    app.classList.remove('show-ui');
  }

  // ---------- reproduzir / pausar ----------
  function tryPlay(){
    var p;
    try{ p=video.play(); }catch(e){}
    if(p && p.catch){
      p.catch(function(err){
        if(err && err.name==='AbortError') return;
        app.classList.remove('loading');
        if(!started) app.classList.add('idle');
        showUI();
      });
    }
  }
  function toggle(){ if(video.paused) tryPlay(); else video.pause(); }
  function icons(){
    var on=!video.paused;
    app.classList.toggle('playing',on);
    app.classList.toggle('paused',!on);
    morphTo(on?1:0);
    btnPlay.setAttribute('aria-label', on?'Pausar':'Reproduzir');
  }
  function armSleep(){
    clearTimeout(sleepT);
    app.classList.remove('sleepy');
    sleepT=setTimeout(function(){
      if(video.paused && !video.ended && !dragging && !has('errored') && !has('resuming') && !has('pip') && !has('loading')){
        app.classList.add('sleepy');
      }
    },900);
  }

  // ---------- continuar de onde parou ----------
  function savePos(){
    var t=video.currentTime, d=video.duration;
    if(!started || !isFinite(t) || !isFinite(d) || d<=0) return;
    if(video.ended || d-t<90){ lsDel(KPOS); return; }
    if(t>=30) lsSet(KPOS,String(Math.floor(t)));
  }
  setInterval(function(){ if(!video.paused) savePos(); },5000);
  window.addEventListener('pagehide',function(){ savePos(); if(hls){ try{ hls.destroy(); }catch(e){} } });
  document.addEventListener('visibilitychange',function(){ if(document.hidden) savePos(); });

  // ---------- erro ----------
  function showError(code){
    if(has('errored')) return;
    clearTimeout(loadT); clearTimeout(stallT); clearTimeout(sleepT);
    savePos();
    try{ video.pause(); }catch(e){}
    setScenes(false); setMenu(false);
    app.classList.remove('loading','sleepy','idle','resuming');
    app.classList.add('errored','show-ui');
    $('errCode').textContent='Código: '+code;
    setTimeout(function(){ $('btnRetry').focus(); },60);
  }
  $('btnRetry').addEventListener('click',function(){ location.reload(); });

  // ---------- fonte de vídeo (nativo / hls.js) ----------
  function engine(){
    if(!C.isHls) return 'native';
    var nat=!!video.canPlayType('application/vnd.apple.mpegurl');
    var js=!!(window.Hls && window.Hls.isSupported && window.Hls.isSupported());
    if(C.nativeFirst){ if(nat) return 'native'; if(js) return 'hlsjs'; }
    else { if(js) return 'hlsjs'; if(nat) return 'native'; }
    return 'none';
  }
  function seekOnce(t){
    if(!(t>0)) return;
    function f(){ video.removeEventListener('loadedmetadata',f); try{ video.currentTime=t; }catch(e){} }
    video.addEventListener('loadedmetadata',f);
  }
  function startSource(startAt, autoplay){
    clearTimeout(loadT);
    loadT=setTimeout(function(){ showError('timeout'); },45000);
    var eng=engine();
    if(eng==='hlsjs'){
      hls=new Hls({
        enableWorker:true,
        capLevelToPlayerSize:true,
        maxBufferLength:30,
        backBufferLength:30,
        startLevel:-1,
        startPosition:(startAt>0?startAt:-1)
      });
      hls.on(Hls.Events.MANIFEST_PARSED,function(){ setMsg(1); if(autoplay) tryPlay(); });
      hls.on(Hls.Events.FRAG_LOADED,function(){ netTries=0; });
      hls.on(Hls.Events.ERROR,function(_,d){
        if(!d || !d.fatal) return;
        if(d.type===Hls.ErrorTypes.NETWORK_ERROR && netTries<3){
          netTries++;
          setTimeout(function(){ try{ hls.startLoad(); }catch(e){} },800*netTries);
          return;
        }
        if(d.type===Hls.ErrorTypes.MEDIA_ERROR && mediaTries<2){
          mediaTries++;
          try{ hls.recoverMediaError(); }catch(e){}
          return;
        }
        showError(d.details || d.type || 'hls');
      });
      hls.loadSource(C.url);
      hls.attachMedia(video);
    } else if(eng==='native'){
      video.src=C.url;
      seekOnce(startAt);
      if(autoplay) tryPlay();
    } else {
      showError('sem-suporte');
    }
  }

  // ---------- eventos do vídeo ----------
  var castWatching=false;
  video.addEventListener('loadedmetadata',function(){
    durEl.textContent=fmt(video.duration);
    prog.setAttribute('aria-valuemax',String(Math.floor(video.duration)||0));
    setMsg(1);
    watchCast();
  });
  video.addEventListener('durationchange',function(){ durEl.textContent=fmt(video.duration); });
  video.addEventListener('loadeddata',function(){ setMsg(2); });
  video.addEventListener('canplay',function(){
    clearTimeout(loadT); clearTimeout(stallT);
    app.classList.remove('loading');
  });
  video.addEventListener('playing',function(){
    clearTimeout(loadT); clearTimeout(stallT);
    app.classList.remove('loading','idle');
    if(!started){ started=true; app.classList.add('started'); }
  });
  video.addEventListener('waiting',function(){
    if(!started) return;
    app.classList.add('loading'); setMsg(1,true);
    clearTimeout(stallT);
    stallT=setTimeout(function(){ if(has('loading')) showError('travado'); },45000);
  });
  video.addEventListener('seeked',function(){ if(video.readyState>=2) app.classList.remove('loading'); });
  video.addEventListener('play',function(){
    app.classList.remove('idle','ended','sleepy');
    clearTimeout(sleepT);
    if(!started) app.classList.add('loading');
    icons(); showUI();
  });
  video.addEventListener('pause',function(){
    icons(); showUI(); savePos();
    if(video.ended) return;
    if(!started){ app.classList.remove('loading'); app.classList.add('idle'); }
    else { app.classList.remove('loading'); armSleep(); }
  });
  video.addEventListener('ended',function(){
    lsDel(KPOS);
    app.classList.add('ended'); app.classList.remove('sleepy');
    icons(); showUI();
  });
  video.addEventListener('error',function(){
    if(hls) return;
    if(video.error) showError('E'+video.error.code);
  });

  // ---------- progresso ----------
  function bufEnd(t){
    var b=video.buffered, i;
    for(i=0;i<b.length;i++){ if(t>=b.start(i)-0.3 && t<=b.end(i)+0.3) return b.end(i); }
    return b.length?b.end(b.length-1):0;
  }
  function updBuf(){
    var d=video.duration;
    if(d>0 && isFinite(d)) buf.style.width=(Math.min(1,bufEnd(video.currentTime||0)/d)*100)+'%';
  }
  function paintRatio(x){ fill.style.width=(x*100)+'%'; thumbEl.style.left=(x*100)+'%'; }
  video.addEventListener('progress',updBuf);
  video.addEventListener('timeupdate',function(){
    var d=video.duration||0, t=video.currentTime||0;
    if(!dragging){ paintRatio(d?Math.min(1,t/d):0); curEl.textContent=fmt(t); }
    updBuf();
    var s=Math.floor(t);
    if(s!==lastSec){
      lastSec=s;
      prog.setAttribute('aria-valuenow',String(s));
      prog.setAttribute('aria-valuetext',fmt(t)+' de '+fmt(d));
      if(scenesOpen) markScene();
    }
  });

  function ratioFrom(e){
    var r=prog.getBoundingClientRect();
    return r.width?Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)):0;
  }
  function moveTip(x){
    tip.textContent=fmt(x*(video.duration||0));
    var w=tip.offsetWidth, tw=prog.clientWidth, px=x*tw;
    px=Math.min(Math.max(tw-w/2,w/2),Math.max(w/2,px));
    tip.style.left=px+'px';
  }
  prog.addEventListener('pointerdown',function(e){
    if(!video.duration || !isFinite(video.duration)) return;
    dragging=true; prog.classList.add('drag');
    app.classList.remove('sleepy'); clearTimeout(sleepT);
    try{ prog.setPointerCapture(e.pointerId); }catch(err){}
    var x=ratioFrom(e); dragRatio=x; paintRatio(x); moveTip(x); curEl.textContent=fmt(x*video.duration);
    showUI();
  });
  prog.addEventListener('pointermove',function(e){
    var x=ratioFrom(e);
    hoverEl.style.width=(x*100)+'%';
    moveTip(x);
    if(dragging){ dragRatio=x; paintRatio(x); curEl.textContent=fmt(x*(video.duration||0)); }
  });
  function endDrag(apply){
    if(!dragging) return;
    dragging=false; prog.classList.remove('drag');
    if(apply && video.duration) video.currentTime=dragRatio*video.duration;
    if(video.paused && started) armSleep();
    showUI();
  }
  prog.addEventListener('pointerup',function(){ endDrag(true); });
  prog.addEventListener('pointercancel',function(){ endDrag(false); });
  prog.addEventListener('keydown',function(e){
    var k=e.key, d=video.duration||0;
    if(k==='ArrowLeft'||k==='ArrowRight'||k==='Home'||k==='End'){
      e.preventDefault(); e.stopPropagation();
      if(k==='ArrowLeft') seekBy(-5);
      else if(k==='ArrowRight') seekBy(5);
      else if(k==='Home') video.currentTime=0;
      else if(d) video.currentTime=Math.max(0,d-1);
      showUI();
    }
  });

  // ---------- pular ±10s (com efeito) ----------
  function seekBy(d){
    var t=(video.currentTime||0)+d, m=video.duration;
    if(isFinite(m)) t=Math.min(t,m);
    video.currentTime=Math.max(0,t);
  }
  var fxAcc={l:0,r:0}, fxT={l:0,r:0};
  function fx(z){
    var el=(z==='l')?fxL:fxR;
    clearTimeout(fxT[z]);
    fxAcc[z]+=10;
    el.querySelector('span').textContent=fxAcc[z]+' segundos';
    el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
    fxT[z]=setTimeout(function(){ fxAcc[z]=0; },900);
  }
  function skip(z){ seekBy(z==='l'?-10:10); fx(z); }

  // ---------- gestos: clique (mouse) e duplo toque (celular) ----------
  function closePanels(){
    var any=menuOpen||scenesOpen;
    if(menuOpen) setMenu(false);
    if(scenesOpen) setScenes(false);
    if(any) panelsClosedAt=Date.now();
    return any;
  }
  function zoneOf(x){
    var w=app.clientWidth||1;
    return x<w*0.35?'l':(x>w*0.65?'r':'c');
  }
  function singleTap(){
    if(has('show-ui') && !uiLocked()){ clearTimeout(hideT); app.classList.remove('show-ui'); }
    else showUI();
  }
  var lastTap=0, lastZone='', tapTimer=0, chainZone='', chainT=0;
  tapEl.addEventListener('pointerdown',function(e){ lastPT=e.pointerType||'mouse'; });
  tapEl.addEventListener('click',function(){
    if(lastPT!=='mouse') return;
    if(closePanels()) return;
    if(Date.now()-panelsClosedAt<400) return;
    toggle(); showUI();
  });
  tapEl.addEventListener('dblclick',function(){ if(lastPT==='mouse') toggleFs(); });
  tapEl.addEventListener('pointerup',function(e){
    if(e.pointerType==='mouse') return;
    if(closePanels()) return;
    if(Date.now()-panelsClosedAt<400) return;
    var now=Date.now(), z=zoneOf(e.clientX);
    if(z!=='c' && chainZone===z && now-chainT<650){
      clearTimeout(tapTimer); lastTap=0; chainT=now; skip(z); return;
    }
    if(now-lastTap<300 && z===lastZone){
      clearTimeout(tapTimer); lastTap=0;
      if(z==='c') toggle();
      else { skip(z); chainZone=z; chainT=now; }
      return;
    }
    lastTap=now; lastZone=z;
    clearTimeout(tapTimer);
    tapTimer=setTimeout(singleTap,300);
  });

  // ---------- volume ----------
  function applyVolUI(){
    var m=video.muted || video.volume===0;
    $('iVol').style.display=m?'none':'block';
    $('iMute').style.display=m?'block':'none';
    volIn.value=video.muted?0:video.volume;
    btnMute.setAttribute('aria-label', m?'Ativar som':'Silenciar');
  }
  function setVol(v,show){
    v=Math.round(Math.max(0,Math.min(1,v))*100)/100;
    video.volume=v; video.muted=(v===0);
    applyVolUI();
    if(show) toast('Volume '+Math.round(v*100)+'%');
  }
  function toggleMute(){
    video.muted=!video.muted;
    if(!video.muted && video.volume===0) video.volume=0.5;
    applyVolUI();
  }
  btnMute.addEventListener('click',toggleMute);
  volIn.addEventListener('input',function(e){ setVol(parseFloat(e.target.value)); });
  video.addEventListener('volumechange',function(){
    applyVolUI();
    lsSet(KVOL,JSON.stringify({v:video.volume,m:video.muted}));
  });
  (function(){
    var raw=lsGet(KVOL);
    if(!raw) return;
    try{ var o=JSON.parse(raw); if(typeof o.v==='number') video.volume=Math.max(0,Math.min(1,o.v)); video.muted=!!o.m; }catch(e){}
  })();
  applyVolUI();

  // ---------- menu de configurações (velocidade) ----------
  function rateLabel(s){ return s===1?'Normal':String(s).replace('.',',')+'x'; }
  (function(){
    menu.innerHTML='<h3>Velocidade</h3>';
    SPEEDS.forEach(function(s){
      var b=document.createElement('button');
      b.type='button'; b.className='mi';
      b.setAttribute('role','menuitemradio');
      b.setAttribute('aria-checked',s===1?'true':'false');
      b.setAttribute('data-s',String(s));
      b.innerHTML='<span>'+rateLabel(s)+'</span><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
      b.addEventListener('click',function(){ setRate(s); setMenu(false); btnSet.focus(); });
      menu.appendChild(b);
    });
  })();
  function setRate(s){
    video.playbackRate=s;
    var items=menu.querySelectorAll('.mi'), i;
    for(i=0;i<items.length;i++) items[i].setAttribute('aria-checked', parseFloat(items[i].getAttribute('data-s'))===s?'true':'false');
    toast('Velocidade: '+rateLabel(s));
  }
  function setMenu(on){
    if(on===menuOpen) return;
    if(on) setScenes(false);
    menuOpen=on;
    menu.classList.toggle('open',on);
    btnSet.setAttribute('aria-expanded',on?'true':'false');
    if(on){
      setTimeout(function(){ var c=menu.querySelector('[aria-checked=true]'); if(c) c.focus(); },30);
    }
    showUI();
  }
  function navMenu(dir){
    var items=Array.prototype.slice.call(menu.querySelectorAll('.mi'));
    var i=items.indexOf(document.activeElement);
    i=(i+dir+items.length)%items.length;
    items[i].focus();
  }
  btnSet.addEventListener('click',function(){ setMenu(!menuOpen); });
  document.addEventListener('pointerdown',function(e){
    if(menuOpen && !(e.target.closest && e.target.closest('.setwrap'))){ setMenu(false); panelsClosedAt=Date.now(); }
  });

  // ---------- tela cheia ----------
  function fsEl(){ return document.fullscreenElement || document.webkitFullscreenElement; }
  function toggleFs(){
    if(fsEl()){ (document.exitFullscreen||document.webkitExitFullscreen).call(document); return; }
    var fn=app.requestFullscreen||app.webkitRequestFullscreen;
    if(fn){
      var p; try{ p=fn.call(app); }catch(e){}
      if(p && p.catch) p.catch(function(){ toast('Tela cheia indisponível aqui'); });
    } else if(video.webkitEnterFullscreen){
      video.webkitEnterFullscreen();
    }
  }
  function onFs(){
    var on=!!fsEl();
    app.classList.toggle('fs',on);
    btnFs.setAttribute('aria-label', on?'Sair da tela cheia':'Tela cheia');
    if(!on){
      app.classList.add('soft');
      setTimeout(function(){ app.classList.remove('soft'); },1300);
    }
    showUI();
  }
  btnFs.addEventListener('click',toggleFs);
  document.addEventListener('fullscreenchange',onFs);
  document.addEventListener('webkitfullscreenchange',onFs);
  video.addEventListener('webkitendfullscreen',function(){ showUI(); });

  // ---------- modo cinema ----------
  function setCinema(on){
    cinema=on;
    app.classList.toggle('cinema',on);
    btnCinema.setAttribute('aria-pressed',on?'true':'false');
    btnCinema.setAttribute('aria-label',on?'Sair do modo cinema':'Modo cinema');
    toast(on?'Modo cinema • aperte T para voltar':'Modo normal');
    try{ if(window.parent && window.parent!==window) window.parent.postMessage({type:'pipocaflix:cinema',on:on},'*'); }catch(e){}
    showUI();
  }
  btnCinema.addEventListener('click',function(){ setCinema(!cinema); });

  // ---------- picture-in-picture ----------
  var pipOk=!!(document.pictureInPictureEnabled && video.requestPictureInPicture) ||
            !!(video.webkitSupportsPresentationMode && video.webkitSupportsPresentationMode('picture-in-picture'));
  btnPip.hidden=!pipOk;
  function togglePip(){
    try{
      if(document.pictureInPictureElement){ document.exitPictureInPicture(); }
      else if(video.requestPictureInPicture){
        video.requestPictureInPicture().catch(function(){ toast('Picture-in-Picture indisponível'); });
      } else if(video.webkitSetPresentationMode){
        video.webkitSetPresentationMode(video.webkitPresentationMode==='picture-in-picture'?'inline':'picture-in-picture');
      }
    }catch(e){ toast('Picture-in-Picture indisponível'); }
  }
  btnPip.addEventListener('click',togglePip);
  video.addEventListener('enterpictureinpicture',function(){ app.classList.add('pip'); app.classList.remove('sleepy'); });
  video.addEventListener('leavepictureinpicture',function(){ app.classList.remove('pip'); });
  video.addEventListener('webkitpresentationmodechanged',function(){
    app.classList.toggle('pip', video.webkitPresentationMode==='picture-in-picture');
  });

  // ---------- transmitir para a TV (AirPlay / Remote Playback) ----------
  function watchCast(){
    if(castWatching) return;
    castWatching=true;
    try{
      if(video.remote && video.remote.watchAvailability){
        video.remote.watchAvailability(function(av){ btnCast.hidden=!av; }).catch(function(){});
      }
    }catch(e){}
  }
  video.addEventListener('webkitplaybacktargetavailabilitychanged',function(e){
    btnCast.hidden=(e.availability!=='available');
  });
  btnCast.addEventListener('click',function(){
    try{
      if(video.webkitShowPlaybackTargetPicker && window.WebKitPlaybackTargetAvailabilityEvent){
        video.webkitShowPlaybackTargetPicker();
      } else if(video.remote && video.remote.prompt){
        video.remote.prompt().catch(function(err){
          toast(err && err.name==='NotFoundError' ? 'Nenhum dispositivo encontrado' : 'Transmissão indisponível para este vídeo');
        });
      }
    }catch(e){ toast('Transmissão indisponível para este vídeo'); }
  });

  // ---------- legendas (tecla C) ----------
  function toggleCaptions(){
    var on;
    if(hls && hls.subtitleTracks && hls.subtitleTracks.length){
      on=hls.subtitleTrack<0;
      hls.subtitleTrack=on?0:-1;
      hls.subtitleDisplay=on;
      toast(on?'Legendas ativadas':'Legendas desativadas');
      return;
    }
    var tt=video.textTracks, i, found=false;
    for(i=0;i<tt.length;i++){
      if(tt[i].kind==='subtitles' || tt[i].kind==='captions'){
        if(!found){ on=(tt[i].mode!=='showing'); found=true; }
        tt[i].mode=on?'showing':'disabled';
      }
    }
    toast(found?(on?'Legendas ativadas':'Legendas desativadas'):'Legendas indisponíveis neste vídeo');
  }

  // ---------- mapa das cenas ----------
  var tj=null, thumbs=[], sceneIdx=-1, scBuilt=false;
  function buildScenes(){
    if(scBuilt) return true;
    var d=video.duration;
    if(!isFinite(d) || d<=0) return false;
    scBuilt=true;
    var i;
    for(i=0;i<SCENES;i++){
      (function(i){
        var b=document.createElement('button');
        b.type='button'; b.className='sc';
        b.setAttribute('aria-label','Ir para '+fmt(d*i/SCENES));
        var c=document.createElement('canvas'); c.width=320; c.height=180;
        var s=document.createElement('span'); s.className='t'; s.textContent=fmt(d*i/SCENES);
        b.appendChild(c); b.appendChild(s);
        b.addEventListener('click',function(){
          video.currentTime=d*i/SCENES;
          setScenes(false);
          tryPlay();
        });
        grid.appendChild(b);
        thumbs.push({el:b,c:c});
      })(i);
    }
    return true;
  }
  function markScene(){
    var d=video.duration;
    if(!thumbs.length || !isFinite(d) || d<=0) return;
    var idx=Math.min(SCENES-1,Math.floor((video.currentTime||0)/d*SCENES));
    if(idx===sceneIdx) return;
    sceneIdx=idx;
    thumbs.forEach(function(t,i){ t.el.classList.toggle('on',i===idx); });
  }
  // gera as miniaturas só enquanto o painel está aberto, com um segundo <video> em baixa qualidade
  function startThumbs(){
    if(tj){ if(!tj.finished) tj.step(); return; }
    if(navigator.connection && navigator.connection.saveData){ grid.classList.add('done'); return; }
    var d=video.duration, tv=document.createElement('video'), th=null, i=0, fails=0, busy=false;
    tj={finished:false, step:step};
    tv.muted=true; tv.preload='auto'; tv.playsInline=true; tv.setAttribute('playsinline','');
    var eng=engine();

    function finish(){
      if(tj.finished) return;
      tj.finished=true; grid.classList.add('done');
      try{ if(th) th.destroy(); }catch(e){}
      try{ tv.removeAttribute('src'); tv.load(); }catch(e){}
    }
    function paint(k){
      try{
        var c=thumbs[k].c, x=c.getContext('2d'), vw=tv.videoWidth, vh=tv.videoHeight;
        if(!vw || !vh) return;
        var sc=Math.max(c.width/vw,c.height/vh), w=vw*sc, h=vh*sc;
        x.drawImage(tv,(c.width-w)/2,(c.height-h)/2,w,h);
        thumbs[k].el.classList.add('has');
      }catch(e){}
    }
    function after(){
      if(fails>=4){ finish(); return; }
      step();
    }
    function step(){
      if(tj.finished || busy || !scenesOpen || tv.readyState<1) return;
      if(i>=SCENES){ finish(); return; }
      busy=true;
      var idx=i, done=false;
      function on(){
        if(done) return;
        done=true; clearTimeout(to);
        tv.removeEventListener('seeked',on);
        paint(idx); i++; busy=false;
        setTimeout(after,80);
      }
      var to=setTimeout(function(){
        if(done) return;
        done=true; tv.removeEventListener('seeked',on);
        fails++; i++; busy=false; after();
      },9000);
      tv.addEventListener('seeked',on);
      try{ tv.currentTime=Math.max(0,Math.min(d-1, d*idx/SCENES+6)); }
      catch(e){ done=true; clearTimeout(to); tv.removeEventListener('seeked',on); fails++; i++; busy=false; after(); }
    }

    tv.addEventListener('loadedmetadata',function(){ step(); });
    tv.addEventListener('error',finish);
    setTimeout(function(){ if(tv.readyState<1) finish(); },20000);

    if(eng==='hlsjs'){
      th=new Hls({enableWorker:false,startLevel:0,capLevelToPlayerSize:true,maxBufferLength:2,maxMaxBufferLength:4,backBufferLength:2});
      th.autoLevelCapping=0;
      th.on(Hls.Events.ERROR,function(_,e){ if(e && e.fatal) finish(); });
      th.loadSource(C.url);
      th.attachMedia(tv);
    } else if(eng==='native'){
      tv.src=C.url;
    } else {
      finish();
    }
  }
  function setScenes(on){
    if(on===scenesOpen) return;
    if(on){
      if(!buildScenes()){ toast('Aguarde o filme carregar'); return; }
      setMenu(false);
    }
    scenesOpen=on;
    app.classList.toggle('scenes-open',on);
    scenesEl.setAttribute('aria-hidden',on?'false':'true');
    btnScenes.setAttribute('aria-expanded',on?'true':'false');
    if(on){
      sceneIdx=-1; markScene(); startThumbs();
      setTimeout(function(){
        try{ if(thumbs[sceneIdx]) thumbs[sceneIdx].el.scrollIntoView({block:'center'}); }catch(e){}
        $('scClose').focus();
      },60);
    } else if(document.activeElement && scenesEl.contains(document.activeElement)){
      btnScenes.focus();
    }
    showUI();
  }
  btnScenes.addEventListener('click',function(){ setScenes(!scenesOpen); });
  $('scClose').addEventListener('click',function(){ setScenes(false); });

  // ---------- botões principais ----------
  btnPlay.addEventListener('click',toggle);
  btnBig.addEventListener('click',toggle);
  $('btnBack').addEventListener('click',function(){ skip('l'); });
  $('btnFwd').addEventListener('click',function(){ skip('r'); });

  // tira o foco dos botões depois de clicar com mouse/toque (o Espaço volta a dar play/pause)
  controls.addEventListener('click',function(e){
    var b=e.target.closest ? e.target.closest('button') : null;
    if(b && e.detail>0 && b!==btnSet) b.blur();
  });
  controls.addEventListener('pointerdown',function(){ showUI(); });
  controls.addEventListener('focusin',function(){ showUI(); });
  app.addEventListener('pointermove',function(e){ if(e.pointerType==='mouse') showUI(); });

  // ---------- atalhos de teclado ----------
  document.addEventListener('keydown',function(e){
    if(e.ctrlKey||e.metaKey||e.altKey) return;
    var k=e.key, tag=e.target && e.target.tagName;
    if(k==='Escape'){
      if(closePanels()) e.preventDefault();
      else if(cinema) setCinema(false);
      return;
    }
    if(has('resuming')||has('errored')) return;
    if(tag==='INPUT' && (k==='ArrowUp'||k==='ArrowDown'||k==='ArrowLeft'||k==='ArrowRight'||k==='Home'||k==='End')) return;
    if(tag==='BUTTON' && (k===' '||k==='Enter')) return;
    if(menuOpen && (k==='ArrowUp'||k==='ArrowDown')){ navMenu(k==='ArrowDown'?1:-1); e.preventDefault(); return; }
    var handled=true;
    if(k===' '||k==='k'||k==='K') toggle();
    else if(k==='ArrowLeft'||k==='j'||k==='J') skip('l');
    else if(k==='ArrowRight'||k==='l'||k==='L') skip('r');
    else if(k==='ArrowUp') setVol(video.volume+0.1,true);
    else if(k==='ArrowDown') setVol(video.volume-0.1,true);
    else if(/^[0-9]$/.test(k)){ if(isFinite(video.duration)) video.currentTime=video.duration*(+k)/10; }
    else if(k==='f'||k==='F') toggleFs();
    else if(k==='m'||k==='M') toggleMute();
    else if(k==='c'||k==='C') toggleCaptions();
    else if(k==='t'||k==='T') setCinema(!cinema);
    else handled=false;
    if(handled){ e.preventDefault(); showUI(); }
  });

  // ---------- início ----------
  mDraw(0);
  if(C.backdrop || C.poster){
    $('backdrop').style.backgroundImage='url('+JSON.stringify(C.backdrop||C.poster)+')';
  }
  var raw=parseInt(lsGet(KPOS),10);
  savedPos=(isFinite(raw) && raw>=30)?raw:0;

  if(savedPos>0){
    app.classList.remove('loading');
    app.classList.add('resuming');
    $('resTime').textContent=fmt(savedPos);
    setTimeout(function(){ $('btnResume').focus(); },80);
    $('btnResume').addEventListener('click',function(){
      app.classList.remove('resuming'); app.classList.add('loading');
      startSource(savedPos,true);
    });
    $('btnRestart').addEventListener('click',function(){
      lsDel(KPOS);
      app.classList.remove('resuming'); app.classList.add('loading');
      startSource(0,true);
    });
  } else {
    startSource(0,true);
  }
  showUI();
})();
`;

// ============================================================================
//  MONTAGEM DA PÁGINA
// ============================================================================
function sendPlayer(res, videoUrl, html, id) {
  const title = pickTitle(html, id);
  const poster = pickPoster(html);
  const isHls = /\.m3u8(\?|$)/i.test(videoUrl);

  const cfg = {
    id: String(id),
    url: videoUrl,
    isHls,
    poster,
    // versão pequena do poster para o fundo borrado (mais leve)
    backdrop: poster ? poster.replace(/\/t\/p\/(?:original|w\d+)\//, '/t/p/w300/') : '',
    nativeFirst: NATIVE_HLS_FIRST,
  };
  const cfgJson = JSON.stringify(cfg)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const safeTitle = escapeHtml(title);

  const page = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#000000">
<title>${safeTitle}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap" rel="stylesheet">
${isHls ? `<script src="${HLS_JS}"></script>` : ''}
<style>:root{--accent:${ACCENT}}${CSS}</style>
</head>
<body>
<div id="app" class="loading show-ui">
  <div class="backdrop" id="backdrop"></div>
  <video id="v" playsinline webkit-playsinline x-webkit-airplay="allow" preload="auto"></video>
  <div class="tap" id="tap"></div>

  <div class="fx l" id="fxL" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg><span></span></div>
  <div class="fx r" id="fxR" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg><span></span></div>
  <div class="pipnote" aria-hidden="true">Reproduzindo em janela flutuante</div>

  <div class="g-top"></div>
  <div class="g-bot"></div>
  <div class="top"><h1>${safeTitle}</h1></div>

  <div class="stage">
    <div class="sleepy">
      <img src="${SLEEP_IMG}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
      <p><b>As imagens foram tirar uma soneca.</b>Clique em reproduzir para despertá-las. 🌙</p>
    </div>
    <button class="big" id="bigPlay" type="button" aria-label="Reproduzir">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z"/></svg>
    </button>
  </div>

  <div class="loader" id="loader" role="status" aria-live="polite">
    <div class="lbox">
      <div class="brand">${escapeHtml(BRAND.toUpperCase())}</div>
      <svg class="pop" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <defs><clipPath id="bk"><path d="M13 30h38l-4.5 29h-29z"/></clipPath></defs>
        <circle class="pk a" cx="32" cy="24" r="3.2"/>
        <circle class="pk b" cx="32" cy="24" r="3.6"/>
        <circle class="pk c" cx="32" cy="24" r="3.2"/>
        <g class="mound">
          <circle cx="19" cy="29" r="6"/><circle cx="27" cy="25" r="7"/><circle cx="37" cy="25" r="7"/><circle cx="45" cy="29" r="6"/><circle cx="32" cy="29" r="6.5"/>
        </g>
        <g clip-path="url(#bk)">
          <rect x="10" y="28" width="44" height="34" fill="#fff"/>
          <rect x="17" y="28" width="7" height="34" fill="${ACCENT}"/>
          <rect x="30" y="28" width="7" height="34" fill="${ACCENT}"/>
          <rect x="43" y="28" width="7" height="34" fill="${ACCENT}"/>
        </g>
        <path d="M13 30h38l-4.5 29h-29z" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="1"/>
      </svg>
      <div class="msg" id="msg">Preparando a sessão…</div>
    </div>
  </div>

  <aside class="scenes" id="scenes" aria-label="Mapa das cenas" aria-hidden="true">
    <header>
      <div><h2>Mapa das cenas</h2><div class="sub">Escolha uma cena para pular até lá</div></div>
      <button class="btn" id="scClose" type="button" aria-label="Fechar mapa das cenas"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </header>
    <div class="grid" id="scGrid"></div>
  </aside>

  <div class="resume" role="dialog" aria-modal="true" aria-label="Continuar de onde parou">
    <div class="card">
      <h2>Continuar de <span id="resTime">0:00</span>?</h2>
      <p>Você parou aqui da última vez.</p>
      <div class="cta">
        <button class="pbtn" id="btnResume" type="button">Continuar</button>
        <button class="gbtn" id="btnRestart" type="button">Do início</button>
      </div>
    </div>
  </div>

  <div class="err" role="alertdialog" aria-modal="true" aria-label="Erro ao carregar o vídeo">
    <div class="card">
      <img src="${ERROR_IMG}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">
      <h2>Algo deu errado 😕</h2>
      <p>Não foi possível carregar o vídeo. O link pode ter expirado — tente novamente para gerar um novo.</p>
      <button class="pbtn" id="btnRetry" type="button" aria-label="Tentar novamente">Tentar novamente</button>
      <small id="errCode"></small>
    </div>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <div class="controls" id="controls" role="group" aria-label="Controles do player">
    <div class="prog" id="prog" role="slider" tabindex="0" aria-label="Barra de progresso" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0:00">
      <div class="track">
        <div class="hover" id="hover"></div>
        <div class="buf" id="buf"></div>
        <div class="fill" id="fill"></div>
      </div>
      <div class="thumb" id="thumb"></div>
      <div class="tip" id="tip" aria-hidden="true">0:00</div>
    </div>
    <div class="row">
      <button class="btn" id="btnPlay" type="button" aria-label="Reproduzir">
        <svg viewBox="6.5 6 24 24" aria-hidden="true" focusable="false"><path id="mph" d="M12 26L18.5 22L18.5 14L12 10ZM18.5 22L25 18L25 18L18.5 14Z"/></svg>
      </button>
      <button class="btn" id="btnBack" type="button" aria-label="Voltar 10 segundos" title="Voltar 10s (J)">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="15.6" font-size="7" font-weight="700" text-anchor="middle" font-family="Roboto,Arial,sans-serif">10</text></svg>
      </button>
      <button class="btn" id="btnFwd" type="button" aria-label="Avançar 10 segundos" title="Avançar 10s (L)">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 13c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6v4l5-5-5-5v4c-4.42 0-8 3.58-8 8s3.58 8 8 8 8-3.58 8-8h-2z"/><text x="12" y="15.6" font-size="7" font-weight="700" text-anchor="middle" font-family="Roboto,Arial,sans-serif">10</text></svg>
      </button>
      <div class="vol">
        <button class="btn" id="btnMute" type="button" aria-label="Silenciar" title="Silenciar (M)">
          <svg id="iVol" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          <svg id="iMute" viewBox="0 0 24 24" style="display:none" aria-hidden="true" focusable="false"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
        </button>
        <input id="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
      </div>
      <div class="time"><span id="cur">0:00</span> / <span id="dur">0:00</span></div>
      <div class="sp"></div>
      <button class="btn" id="btnCinema" type="button" aria-label="Modo cinema" aria-pressed="false" title="Modo cinema (T)">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 6H5c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H5V8h14v8z"/></svg>
      </button>
      <button class="btn" id="btnScenes" type="button" aria-label="Mapa das cenas" aria-expanded="false" aria-controls="scenes" title="Mapa das cenas">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zM13 3h8v8h-8V3zm0 10h8v8h-8v-8z"/></svg>
      </button>
      <button class="btn" id="btnPip" type="button" aria-label="Picture-in-Picture" title="Picture-in-Picture" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/></svg>
      </button>
      <button class="btn" id="btnCast" type="button" aria-label="Transmitir para a TV" title="Transmitir para a TV" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>
      </button>
      <div class="setwrap">
        <button class="btn" id="btnSet" type="button" aria-label="Configurações" aria-haspopup="menu" aria-expanded="false" aria-controls="menu" title="Configurações">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
        </button>
        <div class="menu" id="menu" role="menu" aria-label="Velocidade de reprodução"></div>
      </div>
      <button class="btn" id="btnFs" type="button" aria-label="Tela cheia" title="Tela cheia (F)">
        <svg class="i-enter" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
        <svg class="i-exit" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
      </button>
    </div>
  </div>
</div>
<script>window.__PF=${cfgJson};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // o ticket/link expira: nada de cache (assim "Tentar novamente" sempre gera um novo)
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).send(page);
}
