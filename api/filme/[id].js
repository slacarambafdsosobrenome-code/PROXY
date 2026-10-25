// ============================================================================
//  PipocaFlix • Player de filmes  (Vercel / Node)        api/filme/[id].js
//
//  GET  /filme/{tmdb_id}                  → página do player (HTML)
//  GET  /filme/{tmdb_id}?ficha=1&nome=…   → JSON: ficha do filme + recomendações (vem da planilha)
//  POST /filme/{tmdb_id}                  → telemetria técnica anônima (só chega se o espectador autorizar)
// ============================================================================
const BASE = 'https://redeflixapi.store';

// ---- Ajustes rápidos -------------------------------------------------------
const BRAND = 'PipocaFlix';
const ACCENT = '#ff2a2a'; // cor de destaque (barra, botões, loader)
const SITE_URL = 'https://www.pipocaflix.fun'; // site principal (usado em "Assistir" quando o filme não tem player próprio)
const SLEEP_IMG = 'https://i.ibb.co/GvwSZ1yM/transferir.png'; // imagem do cartão de pausa ('' = sem imagem)
const ERROR_IMG = 'https://i.pinimg.com/736x/20/d2/fd/20d2fdf6742140fd80973142ea36ceab.jpg'; // imagem da tela de erro ('' = sem imagem)

// Planilha (mesmo Worker que o api.js do site usa)
const SHEET_WORKER = 'https://autumn-pine-50da.slacarambafdsosobrenome.workers.dev';
const SHEET_ROUTE = '/filmes';
const SHEET_TTL = 5 * 60 * 1000;

// hls.js: tenta cada CDN em ordem se o anterior falhar
const HLS_CDNS = [
  'https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js',
  'https://unpkg.com/hls.js@1.5.8/dist/hls.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.8/hls.min.js',
];
// 'auto' = HLS nativo no Safari/iPhone/iPad e hls.js nos demais | 'native' | 'hlsjs'
const HLS_ENGINE = 'auto';
// Telemetria técnica anônima: só funciona se o espectador ligar em Configurações. Deixe '' para remover a opção.
const TELEMETRY = true;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ============================================================================
//  HANDLER
// ============================================================================
module.exports = async function handler(req, res) {
  const q = req.query || {};
  const id = q.id;

  if (req.method === 'POST') return receiveTelemetry(req, res);
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).send('Use /filme/{tmdb_id}');
  }
  if (q.ficha) return sendFicha(res, id, String(q.nome || ''));

  let stage = 'página';
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
      return sendError(res, 502, 'Não conseguimos abrir este filme agora.', 'página', 'HTTP ' + pageRes.status);
    }
    const html = await pageRes.text();

    // 2) extrai o ticket (sem executar código vindo de fora)
    stage = 'ticket';
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
      return sendError(res, 404, 'Este filme ainda não tem reprodução disponível.', 'ticket', 'sem ticket');
    }

    // 3) troca o ticket pelo link do vídeo (MESMA request = mesmo "dispositivo")
    stage = 'fonte';
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
        'fonte',
        srcJson.error ? String(srcJson.error) : 'HTTP ' + srcRes.status
      );
    }
    return sendPlayer(res, srcJson.url, html, id);
  } catch (e) {
    console.error('[player]', stage, e);
    return sendError(res, 500, 'Algo inesperado aconteceu ao carregar o filme.', stage, 'erro interno');
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
  const bad = (t) => !t || /blocked/i.test(t);
  const clean = (t) => decodeEntities(String(t).replace(/\s*-\s*RedeFlixApi.*/i, '').trim());

  // 1) variável do player (mais confiável)
  let m = html.match(/playerTitle\s*=\s*["']([^"']+)["']/);
  if (m && !bad(m[1])) return clean(m[1]);

  // 2) og:title
  m = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["']\s+property=["']og:title["']/i);
  if (m && !bad(m[1])) return clean(m[1]);

  // 3) nome no seletor de servidor
  m = html.match(/server-subtitle[\s\S]*?<strong>([^<]+)<\/strong>/i);
  if (m && !bad(m[1])) return clean(m[1]);

  // 4) <title> (só se não for Blocked)
  m = html.match(/<title>([^<]+)<\/title>/i);
  if (m && !bad(m[1])) return clean(m[1]);

  return 'Filme ' + id;
}
function pickDesc(html) {
  const m =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]).slice(0, 500) : '';
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

function safeJson(obj) {
  // </script> e separadores de linha Unicode não podem aparecer cru dentro do <script>
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
//  PLANILHA (Google Sheets via Worker) → ficha + recomendações
// ============================================================================
// CSV de verdade: respeita aspas, vírgulas e quebras de linha dentro da célula.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur.trim()); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur.trim());
  if (row.length > 1 || row[0]) rows.push(row);
  return rows;
}

const ID_COLS = [1, 15, 16, 17, 18, 19, 20, 21, 23]; // onde um link ".../filme/{id}" pode estar na linha
const ID_RE = /\/filme\/(\d{1,9})(?:[\/?#"'\s]|$)/;
const AGE_RE = /^(livre|l|\+?(?:10|12|14|16|18)(?:\s*anos?)?)$/i;

function mapFilme(row) {
  let tmdb = '';
  for (const i of ID_COLS) {
    const m = ID_RE.exec(row[i] || '');
    if (m) { tmdb = m[1]; break; }
  }
  let classificacao = '';
  for (const i of [10, 13, 14, 21, 23]) {
    if (AGE_RE.test((row[i] || '').trim())) { classificacao = row[i].trim(); break; }
  }
  const cats = (row[4] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    nome: row[0] || '',
    sinopse: row[2] || '',
    capa: row[3] || '',
    categorias: cats,
    ano: row[5] || '',
    duracao: row[6] || '',
    trailer: row[7] || '',
    elencoNomes: (row[8] || '').split(',').map((s) => s.trim()).filter(Boolean),
    elencoFotos: (row[9] || '').split(',').map((s) => s.trim()),
    audio: row[12] || '',
    backdrop: row[20] || '',
    visivel: (row[22] || '').trim().toUpperCase() !== 'FALSE', // coluna W
    plataforma: row[24] || '',
    tmdb,
    classificacao,
    norm: normalize(row[0] || ''),
  };
}

let SHEET = { ts: 0, rows: null, pending: null };

async function loadSheet() {
  if (SHEET.rows && Date.now() - SHEET.ts < SHEET_TTL) return SHEET.rows;
  if (SHEET.pending) return SHEET.pending;
  SHEET.pending = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch(SHEET_WORKER + SHEET_ROUTE, {
        signal: ctrl.signal,
        headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': UA },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = parseCsv(await r.text())
        .slice(1)
        .filter((x) => x[0] && x[0].trim())
        .map(mapFilme);
      SHEET.rows = rows;
      SHEET.ts = Date.now();
      return rows;
    } catch (e) {
      if (SHEET.rows) return SHEET.rows; // se falhar, usa a última cópia boa
      throw e;
    } finally {
      clearTimeout(timer);
      SHEET.pending = null;
    }
  })();
  return SHEET.pending;
}

function findFilm(rows, id, nome) {
  // 1) algum link da linha aponta para /filme/{id}
  let hit = rows.find((r) => r.tmdb === String(id));
  if (hit) return { film: hit, by: 'id' };
  const n = normalize(nome);
  if (!n) return null;
  // 2) mesmo nome
  hit = rows.find((r) => r.norm === n);
  if (hit) return { film: hit, by: 'nome' };
  // 3) nome parecido, só se der um único candidato (evita pegar o filme errado)
  if (n.length >= 6) {
    const c = rows.filter((r) => r.norm && (r.norm.includes(n) || n.includes(r.norm)) && Math.min(r.norm.length, n.length) >= 6);
    if (c.length === 1) return { film: c[0], by: 'parcial' };
  }
  return null;
}

function slimFilm(f, score) {
  return {
    nome: f.nome,
    capa: f.capa,
    ano: f.ano,
    duracao: f.duracao,
    categorias: f.categorias.slice(0, 4),
    audio: f.audio,
    plataforma: f.plataforma,
    sinopse: f.sinopse.length > 220 ? f.sinopse.slice(0, 217).trimEnd() + '…' : f.sinopse,
    tmdb: f.tmdb,
    sc: Math.round(score * 100) / 100,
  };
}

function buildFicha(rows, id, nome) {
  const found = findFilm(rows, id, nome);
  const cur = found && found.film;
  const curG = new Set(cur ? cur.categorias.map(normalize) : []);
  const curCast = new Set(cur ? cur.elencoNomes.map(normalize) : []);
  const curYear = cur ? parseInt(cur.ano, 10) : NaN;
  const jitter = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (Math.abs(h) % 100) / 400; };

  const scored = [];
  for (const f of rows) {
    if (!f.visivel || (cur && f === cur)) continue;
    if (!cur && f.norm === normalize(nome)) continue;
    let s = jitter(f.nome);
    const g = f.categorias.map(normalize);
    g.forEach((x, i) => { if (curG.has(x)) s += i === 0 && cur && normalize(cur.categorias[0]) === x ? 4 : 2.5; });
    f.elencoNomes.forEach((x) => { if (curCast.has(normalize(x))) s += 2; });
    if (cur && f.plataforma && f.plataforma === cur.plataforma) s += 0.5;
    if (cur && f.audio && f.audio === cur.audio) s += 0.3;
    const y = parseInt(f.ano, 10);
    if (isFinite(y) && isFinite(curYear)) s += Math.max(0, 1 - Math.abs(y - curYear) / 25);
    if (f.capa) s += 0.4;
    scored.push([s, f]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const recs = scored.slice(0, 24).map(([s, f]) => slimFilm(f, s));

  let meta = null;
  if (cur) {
    meta = {
      nome: cur.nome,
      sinopse: cur.sinopse.slice(0, 1400),
      capa: cur.capa,
      backdrop: cur.backdrop,
      categorias: cur.categorias,
      ano: cur.ano,
      duracao: cur.duracao,
      audio: cur.audio,
      plataforma: cur.plataforma,
      classificacao: cur.classificacao,
      trailer: cur.trailer,
      elenco: cur.elencoNomes.slice(0, 14).map((n, i) => ({ n, f: cur.elencoFotos[i] || '' })),
    };
  }
  return { ok: true, matched: !!cur, by: found ? found.by : '', meta, recs };
}

async function sendFicha(res, id, nome) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const rows = await loadSheet();
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(JSON.stringify(buildFicha(rows, id, nome)));
  } catch (e) {
    console.error('[ficha]', e && e.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(JSON.stringify({ ok: false, error: 'planilha indisponível' }));
  }
}

// ============================================================================
//  TELEMETRIA (anônima, só com autorização do espectador, só números e códigos)
// ============================================================================
async function receiveTelemetry(req, res) {
  try {
    let body = req.body;
    if (body === undefined || body === null || body === '') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') body = JSON.parse(body.slice(0, 2000));
    const clean = {};
    for (const k of ['ev', 'stage', 'code', 'eng', 'lay']) if (body[k]) clean[k] = String(body[k]).slice(0, 40);
    for (const k of ['ms', 'stalls', 'v']) if (isFinite(body[k])) clean[k] = Math.round(+body[k]);
    console.log('[telemetria]', JSON.stringify(clean));
  } catch (e) { /* ignora lixo */ }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(204).end();
}

// ============================================================================
//  TELA DE ERRO (servidor)
// ============================================================================
function sendError(res, status, message, stage, code) {
  const page = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Algo deu errado • ${escapeHtml(BRAND)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;background:#000;color:#fff;font-family:Roboto,system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:radial-gradient(ellipse at 50% 30%,#2a0d0f,#000 70%)}
.card{display:flex;flex-direction:column;align-items:center;max-width:420px;width:100%;text-align:center;padding:24px 22px;border-radius:24px;background:rgba(20,20,20,.7);border:1px solid rgba(255,255,255,.1);box-shadow:0 20px 60px rgba(0,0,0,.6)}
.card>*+*{margin-top:12px}
.brand{font-weight:900;letter-spacing:.32em;font-size:12px;color:${ACCENT}}
img{width:min(300px,70%);max-height:34vh;object-fit:cover;border-radius:16px}
h1{font-size:22px}
p{font-size:14px;line-height:1.5;color:rgba(255,255,255,.75)}
.chip{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.08);font-size:11px;color:rgba(255,255,255,.6)}
button{padding:12px 26px;border:0;border-radius:999px;background:${ACCENT};color:#fff;font-weight:700;font-size:14px;font-family:inherit;cursor:pointer}
button:hover{filter:brightness(1.12)}
button:focus{outline:3px solid #fff;outline-offset:3px}
</style>
</head>
<body>
<div class="card" role="alert">
  <div class="brand">${escapeHtml(BRAND.toUpperCase())}</div>
  ${ERROR_IMG ? `<img src="${escapeHtml(ERROR_IMG)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
  <h1>Algo deu errado 😕</h1>
  <p>${escapeHtml(message)}</p>
  <button type="button" onclick="location.reload()" aria-label="Tentar novamente">Tentar novamente</button>
  <span class="chip">Etapa: ${escapeHtml(stage)} · ${escapeHtml(String(code || '').slice(0, 60))}</span>
</div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(page);
}

// ============================================================================
//  MONTAGEM DA PÁGINA
// ============================================================================
function ic(id) {
  return `<svg aria-hidden="true" focusable="false"><use href="#i-${id}"/></svg>`;
}

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></symbol>
<symbol id="i-replay" viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></symbol>
<symbol id="i-b10" viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="16.6" font-size="7.2" font-weight="700" text-anchor="middle" font-family="Roboto,Arial,sans-serif">10</text></symbol>
<symbol id="i-f10" viewBox="0 0 24 24"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="12" y="16.6" font-size="7.2" font-weight="700" text-anchor="middle" font-family="Roboto,Arial,sans-serif">10</text></symbol>
<symbol id="i-b5" viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="12" y="16.6" font-size="7.6" font-weight="700" text-anchor="middle" font-family="Roboto,Arial,sans-serif">5</text></symbol>
<symbol id="i-vol" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></symbol>
<symbol id="i-mute" viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></symbol>
<symbol id="i-fs" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></symbol>
<symbol id="i-fsx" viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></symbol>
<symbol id="i-pip" viewBox="0 0 24 24"><path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/></symbol>
<symbol id="i-cast" viewBox="0 0 24 24"><path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></symbol>
<symbol id="i-gear" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></symbol>
<symbol id="i-grid" viewBox="0 0 24 24"><path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zM13 3h8v8h-8V3zm0 10h8v8h-8v-8z"/></symbol>
<symbol id="i-tune" viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></symbol>
<symbol id="i-film" viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></symbol>
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></symbol>
<symbol id="i-book" viewBox="0 0 24 24"><path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z"/></symbol>
<symbol id="i-wide" viewBox="0 0 24 24"><path d="M19 12h-2v3h-3v2h5v-5zM7 9h3V7H5v5h2V9zm14-6H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.99h18v14.02z"/></symbol>
<symbol id="i-rotate" viewBox="0 0 24 24"><path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z"/></symbol>
<symbol id="i-mark" viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15l-5-2.18L7 18V5h10v13z"/></symbol>
<symbol id="i-marked" viewBox="0 0 24 24"><path d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"/></symbol>
</defs></svg>`;

const MPH = 'M8 5L13.5 8.4L13.5 15.6L8 19ZM13.5 8.4L19 12L19 12L13.5 15.6Z';

function sendPlayer(res, videoUrl, html, id) {
  const title = pickTitle(html, id);
  const poster = pickPoster(html);
  const isHls = /\.m3u8(\?|$)/i.test(videoUrl);
  let vidOrigin = '';
  try { vidOrigin = new URL(videoUrl).origin; } catch (e) { /* url relativa */ }

  const cfg = {
    id: String(id),
    url: videoUrl,
    isHls,
    title,
    desc: pickDesc(html),
    poster,
    // versão pequena do poster para o fundo borrado (mais leve)
    backdrop: poster ? poster.replace(/\/t\/p\/(?:original|w\d+)\//, '/t/p/w300/') : '',
    engine: HLS_ENGINE,
    hlsCdns: HLS_CDNS,
    site: SITE_URL,
    tele: !!TELEMETRY,
  };
  const safeTitle = escapeHtml(title);

  const page = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#000000">
<title>${safeTitle}</title>
${vidOrigin ? `<link rel="preconnect" href="${escapeHtml(vidOrigin)}" crossorigin>` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>:root{--accent:${ACCENT}}${CSS}</style>
</head>
<body>
${SPRITE}
<div id="app" class="is-ui" data-phase="boot" data-panel="" data-lay="phone" data-sz="s">
<div id="rig">
  <div class="backdrop" id="backdrop"></div>
  <video id="v" playsinline webkit-playsinline x-webkit-airplay="allow" preload="auto"></video>
  <div id="tint"></div>
  <div class="tap" id="tap"></div>

  <div class="fx l" id="fxL" aria-hidden="true">${ic('b10')}<span></span></div>
  <div class="fx r" id="fxR" aria-hidden="true">${ic('f10')}<span></span></div>
  <div class="pipnote" aria-hidden="true">Reproduzindo em janela flutuante</div>

  <div class="gtop"></div>
  <div class="gbot"></div>

  <header class="top" id="top">
    <div class="ttl"><h1 id="ttl">${safeTitle}</h1><div class="endat" id="endAt"></div></div>
    <div class="clock" id="clock" aria-hidden="true"></div>
    <div class="tacts">
      <button class="btn" id="btnInfo" type="button" aria-label="Ficha do filme" title="Ficha do filme (I)" aria-expanded="false">${ic('info')}</button>
      <button class="btn" id="btnScenes" type="button" aria-label="Mapa das cenas" title="Mapa das cenas (S)" aria-expanded="false">${ic('grid')}</button>
      <button class="btn" id="btnModes" type="button" aria-label="Modos de exibição" title="Modos de exibição (O)" aria-expanded="false">${ic('tune')}<i class="dot"></i></button>
      <button class="btn" id="btnSet" type="button" aria-label="Configurações" title="Configurações" aria-haspopup="menu" aria-expanded="false" aria-controls="menu">${ic('gear')}</button>
    </div>
  </header>

  <div class="stage">
    <div class="nap" id="nap" aria-hidden="true">
      ${SLEEP_IMG ? `<img src="${escapeHtml(SLEEP_IMG)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
      <div class="txt"><b>As imagens foram tirar uma soneca.</b><span>Clique em reproduzir para despertá-las. 🌙</span></div>
    </div>
    <div class="mid" id="mid">
      <button class="mbtn m5" id="mBack5" type="button" aria-label="Voltar 5 segundos">${ic('b5')}</button>
      <button class="mbtn" id="mBack" type="button" aria-label="Voltar 10 segundos">${ic('b10')}</button>
      <button class="mbtn main" id="mPlay" type="button" aria-label="Reproduzir"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="mph" d="${MPH}"/></svg></button>
      <button class="mbtn" id="mFwd" type="button" aria-label="Avançar 10 segundos">${ic('f10')}</button>
    </div>
  </div>

  <div class="loader" id="loader" role="status" aria-live="polite">
    <div class="lbox">
      <div class="brand">${escapeHtml(BRAND.toUpperCase())}</div>
      <svg class="pop" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <defs><clipPath id="bk"><path d="M13 30h38l-4.5 29h-29z"/></clipPath></defs>
        <circle class="pk a" cx="32" cy="24" r="3.2"/>
        <circle class="pk b" cx="32" cy="24" r="3.6"/>
        <circle class="pk c" cx="32" cy="24" r="3.2"/>
        <g fill="#ffe9a8" stroke="#f1c25e" stroke-width="1.2">
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

  <div class="menu" id="menu" role="menu" aria-label="Configurações"></div>

  <aside class="drawer" id="drawer" aria-hidden="true" aria-labelledby="dTitle">
    <div class="dh"><h2 id="dTitle">Painel</h2><button class="btn" id="dClose" type="button" aria-label="Fechar painel">${ic('close')}</button></div>
    <div class="dbody">
      <section class="dsec" id="pScenes"><p class="sub" id="scSub">Escolha uma cena para pular até lá.</p><div class="grid" id="scGrid"></div></section>
      <section class="dsec" id="pInfo"><div id="infoBody"></div></section>
      <section class="dsec" id="pModes"><div id="modesBody"></div></section>
    </div>
  </aside>

  <div class="ovl" id="next" role="dialog" aria-label="Próximo filme"><div class="card" id="nextCard"></div></div>

  <div class="ovl" id="resume" role="dialog" aria-modal="true" aria-label="Continuar de onde parou">
    <div class="card">
      <h2>Continuar de <span id="resTime">0:00</span>?</h2>
      <p>Você parou aqui da última vez.</p>
      <div class="cta">
        <button class="pbtn" id="btnResume" type="button">Continuar</button>
        <button class="gbtn" id="btnRestart" type="button">Do início</button>
      </div>
    </div>
  </div>

  <div class="ovl" id="err" role="alertdialog" aria-modal="true" aria-label="Erro ao carregar o vídeo">
    <div class="card">
      ${ERROR_IMG ? `<img src="${escapeHtml(ERROR_IMG)}" alt="" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ''}
      <h2>Algo deu errado 😕</h2>
      <p id="errMsg">Não foi possível carregar o vídeo. O link pode ter expirado — tente novamente para gerar um novo.</p>
      <button class="pbtn" id="btnRetry" type="button" aria-label="Tentar novamente">Tentar novamente</button>
      <div><span class="stg" id="errStage"></span></div>
    </div>
  </div>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <div class="controls" id="controls" role="group" aria-label="Controles do player">
    <div class="prow">
      <span class="tm" id="cur" aria-hidden="true">0:00</span>
      <div class="prog" id="prog" role="slider" tabindex="0" aria-label="Barra de progresso" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0:00">
        <div class="track">
          <div class="hover" id="hover"></div>
          <div class="buf" id="buf"></div>
          <div class="fill" id="fill"></div>
        </div>
        <div class="thumb" id="thumb"></div>
        <div class="tip" id="tip" aria-hidden="true">0:00</div>
      </div>
      <span class="tm" id="rem" title="Tempo restante" aria-hidden="true">-0:00</span>
    </div>
    <div class="cl">
      <button class="btn" id="btnPlay" type="button" aria-label="Reproduzir" title="Reproduzir (espaço)"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="mph" d="${MPH}"/></svg></button>
      <button class="btn" id="btnBack" type="button" aria-label="Voltar 10 segundos" title="Voltar 10s (J)">${ic('b10')}</button>
      <button class="btn" id="btnFwd" type="button" aria-label="Avançar 10 segundos" title="Avançar 10s (L)">${ic('f10')}</button>
      <div class="vol">
        <button class="btn" id="btnMute" type="button" aria-label="Silenciar" title="Silenciar (M)"><svg id="iVol" aria-hidden="true" focusable="false"><use href="#i-vol"/></svg><svg id="iMute" aria-hidden="true" focusable="false" style="display:none"><use href="#i-mute"/></svg></button>
        <input id="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
      </div>
    </div>
    <div class="cr">
      <button class="btn" id="btnCast" type="button" aria-label="Transmitir para a TV" title="Transmitir para a TV" hidden>${ic('cast')}</button>
      <button class="btn" id="btnPip" type="button" aria-label="Picture-in-Picture" title="Picture-in-Picture (P)" hidden>${ic('pip')}</button>
      <button class="btn" id="btnFs" type="button" aria-label="Tela cheia" title="Tela cheia (F)"><svg class="i-enter" aria-hidden="true" focusable="false"><use href="#i-fs"/></svg><svg class="i-exit" aria-hidden="true" focusable="false"><use href="#i-fsx"/></svg></button>
    </div>
  </div>
</div>
</div>
<script>window.__PF=${safeJson(cfg)};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // o ticket/link expira: nada de cache (assim "Tentar novamente" sempre gera um novo)
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).send(page);
}
// ============================================================================
//  CSS DO PLAYER
//  Estados ficam no #app: data-phase, data-panel, data-lay, data-sz e classes is-* / m-*
//  (nomes de estado NUNCA repetem nomes de elementos — foi isso que escondia o player ao pausar)
// ============================================================================
const CSS = String.raw`
*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
:root{color-scheme:dark;--glass:rgba(18,18,22,.62);--line:rgba(255,255,255,.13);--ease:cubic-bezier(.2,.8,.2,1)}
html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:Roboto,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#fff;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;overscroll-behavior:none;-webkit-text-size-adjust:100%}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;touch-action:manipulation}
a{color:inherit;text-decoration:none}
button:focus,a:focus,[role=slider]:focus,input:focus{outline:3px solid #fff;outline-offset:2px}
button:focus:not(:focus-visible),a:focus:not(:focus-visible),[role=slider]:focus:not(:focus-visible),input:focus:not(:focus-visible){outline:none}
svg{display:block;fill:currentColor;flex:none}

/* ---------- tamanhos (data-sz) e variáveis ---------- */
#app{--btn:40px;--ico:24px;--txt:13px;--mbig:64px;--msm:46px;--bm:10px;--toph:54px;--barw:1000px}
#app[data-sz="l"]{--btn:44px;--ico:26px;--txt:14px;--mbig:76px;--msm:54px;--bm:14px;--toph:62px}
#app[data-sz="xl"]{--btn:52px;--ico:30px;--txt:16px;--mbig:92px;--msm:64px;--bm:18px;--toph:72px;--barw:1240px}
#app[data-sz="xxl"]{--btn:66px;--ico:38px;--txt:21px;--mbig:116px;--msm:80px;--bm:24px;--toph:92px;--barw:1700px}
#app.m-read{--btn:46px;--ico:27px;--txt:15px}

#app{position:fixed;top:0;right:0;bottom:0;left:0;background:#000;overflow:hidden;cursor:none}
#app.is-ui{cursor:default}
#rig{position:absolute;top:0;right:0;bottom:0;left:0;overflow:hidden;font-size:var(--txt)}

/* modo "girar tela" (quando o aparelho não deixa travar em paisagem) */
#app.is-rot #rig{top:0;left:100vw;right:auto;bottom:auto;width:100vh;height:100vw;transform-origin:0 0;transform:rotate(90deg)}
#app.is-rot.is-flip #rig{top:100vh;left:0;transform:rotate(-90deg)}

/* ---------- vídeo, fundo e camadas ---------- */
.backdrop{position:absolute;top:0;right:0;bottom:0;left:0;z-index:1;background:#000 center/cover no-repeat;filter:blur(18px) brightness(.42);transform:scale(1.1);opacity:0;visibility:hidden;transition:opacity .5s,visibility 0s .5s}
#app:not(.is-started) .backdrop{opacity:1;visibility:visible;transition-delay:0s}
video{position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;object-fit:contain;background:transparent;z-index:2;transform-origin:center center}
#tint{position:absolute;top:0;right:0;bottom:0;left:0;z-index:3;pointer-events:none;opacity:0;background:linear-gradient(rgba(255,150,40,.17),rgba(255,120,20,.17)),rgba(0,0,0,.13);transition:opacity .5s}
#app.m-night #tint{opacity:1}
#app.m-night{--accent:#ee9437}
.tap{position:absolute;top:0;right:0;bottom:0;left:0;z-index:5;touch-action:manipulation}
.pipnote{position:absolute;top:0;right:0;bottom:0;left:0;z-index:12;display:none;align-items:center;justify-content:center;pointer-events:none;color:rgba(255,255,255,.7);font-size:1.1em;background:#000;text-align:center;padding:20px}
#app.is-pip .pipnote{display:flex}

.gtop,.gbot{position:absolute;left:0;right:0;pointer-events:none;opacity:0;transition:opacity .3s;z-index:10}
.gtop{top:0;height:130px;background:linear-gradient(to bottom,rgba(0,0,0,.66),transparent)}
.gbot{bottom:0;height:170px;background:linear-gradient(to top,rgba(0,0,0,.55),transparent)}
#app.is-ui .gtop,#app.is-ui .gbot{opacity:1}

/* ---------- barra superior ---------- */
.top{position:absolute;top:0;left:0;right:0;z-index:30;display:flex;align-items:center;padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) 6px max(14px,env(safe-area-inset-left));opacity:0;transform:translateY(-6px);transition:opacity .3s,transform .3s;pointer-events:none}
#app.is-ui .top{opacity:1;transform:none}
.ttl{flex:1;min-width:0;padding-right:8px;text-shadow:0 1px 6px rgba(0,0,0,.85)}
.ttl h1{font-size:1.08em;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.endat{font-size:.85em;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.2em}
.clock{font-size:.95em;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.8);padding:0 8px;white-space:nowrap;text-shadow:0 1px 6px rgba(0,0,0,.85)}
.tacts{display:flex;align-items:center;flex:none}
#app.is-ui .top .btn,#app.is-ui .top .ttl{pointer-events:auto}

.btn{position:relative;width:var(--btn);height:var(--btn);border-radius:50%;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,transform .15s;flex:none}
.btn svg{width:var(--ico);height:var(--ico)}
.btn:hover{background:rgba(255,255,255,.15)}
.btn:active{transform:scale(.92)}
.btn[aria-pressed=true],.btn[aria-expanded=true]{color:var(--accent)}
#btnSet[aria-expanded=true] svg{transform:rotate(45deg)}
.btn svg{transition:transform .25s}
.dot{position:absolute;top:7px;right:7px;width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px rgba(0,0,0,.5);display:none}
.btn.has-dot .dot{display:block}

/* ---------- centro: soneca + botões ---------- */
.stage{position:absolute;top:0;right:0;bottom:0;left:0;z-index:20;pointer-events:none}
.mid{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.94);display:flex;align-items:center;justify-content:center;opacity:0;visibility:hidden;transition:opacity .25s,transform .25s,visibility 0s .25s}
#app.is-ui .mid{opacity:1;visibility:visible;transform:translate(-50%,-50%);transition-delay:0s}
#app.is-buffering .mid,#app.is-next .mid,#app[data-phase="error"] .mid,#app[data-phase="resume"] .mid,#app[data-phase="boot"] .mid,#app.is-pip .mid,#app:not([data-panel=""]) .mid{opacity:0;visibility:hidden}
.mbtn{pointer-events:none;width:var(--msm);height:var(--msm);border-radius:50%;margin:0 calc(var(--mbig) * .22);display:flex;align-items:center;justify-content:center;background:rgba(18,18,22,.5);border:1px solid var(--line);transition:background .15s,transform .15s}
#app.is-ui .mbtn{pointer-events:auto}
.mbtn svg{width:calc(var(--msm) * .62);height:calc(var(--msm) * .62)}
.mbtn:hover{background:rgba(40,40,46,.7)}
.mbtn:active{transform:scale(.92)}
.mbtn.main{width:var(--mbig);height:var(--mbig);background:rgba(18,18,22,.58)}
.mbtn.main svg{width:calc(var(--mbig) * .5);height:calc(var(--mbig) * .5)}
.mbtn.main:hover{background:var(--accent);border-color:transparent}
.mbtn.m5{display:none;width:calc(var(--msm) * .86);height:calc(var(--msm) * .86);margin:0}
#app.m-read .mbtn.m5{display:flex}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){
  .mbtn,.controls,.menu,.drawer,.toast,.card,.lbox,.nap .txt{-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%)}
}

.nap{position:absolute;left:50%;bottom:calc(50% + var(--mbig) / 2 + 14px);transform:translate(-50%,10px);width:min(88%,calc(var(--txt) * 30));text-align:center;opacity:0;pointer-events:none;transition:opacity .35s,transform .35s var(--ease)}
#app.is-nap .nap{opacity:1;transform:translate(-50%,0)}
.nap img{display:block;margin:0 auto 10px;max-width:60%;max-height:min(calc(var(--rh,420px) * .22),calc(var(--rh,420px) * .5 - var(--mbig) / 2 - 14px - 56px - var(--txt) * 7 - 10px));width:auto;height:auto;object-fit:contain;border-radius:16px;filter:drop-shadow(0 8px 22px rgba(0,0,0,.5))}
.nap .txt{display:inline-block;padding:9px 16px;border-radius:16px;background:rgba(10,10,14,.55);line-height:1.45;text-shadow:0 1px 6px rgba(0,0,0,.6)}
.nap b{display:block;font-size:1.08em;margin-bottom:1px}
.nap span{font-size:.95em;color:rgba(255,255,255,.85)}
#app[data-lay="tiny"] .nap img,#app[data-lay="phone-l"] .nap img{display:none}
#app[data-lay="tiny"] .nap{display:none}
#app.m-cinema .nap{display:none}

/* ---------- ±10s (círculo) ---------- */
.fx{position:absolute;top:50%;z-index:8;width:calc(var(--mbig) * 1.45);height:calc(var(--mbig) * 1.45);margin-top:calc(var(--mbig) * -.725);border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(255,255,255,.18);font-weight:700;font-size:.95em;opacity:0;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.fx.l{left:12%}
.fx.r{right:12%}
.fx svg{width:calc(var(--mbig) * .5);height:calc(var(--mbig) * .5)}
.fx.go{animation:fx .8s ease-out}
@keyframes fx{0%{opacity:0;transform:scale(.7)}18%{opacity:1;transform:scale(1)}78%{opacity:1}100%{opacity:0;transform:scale(1.08)}}

/* ---------- carregando ---------- */
.loader{position:absolute;top:0;right:0;bottom:0;left:0;z-index:50;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .25s,visibility 0s .25s}
#app.is-buffering .loader{opacity:1;visibility:visible;transition-delay:0s}
.lbox{display:flex;flex-direction:column;align-items:center;padding:16px 24px;border-radius:22px}
.lbox>*+*{margin-top:10px}
#app.is-started .lbox{background:rgba(0,0,0,.5)}
.brand{font-weight:900;letter-spacing:.34em;font-size:.95em;color:var(--accent);text-indent:.34em}
#app.is-started .brand{display:none}
.pop{width:64px;height:64px;overflow:visible;animation:bob 1.6s ease-in-out infinite}
.pk{fill:#fff3c4;stroke:#f1c25e;stroke-width:1;transform-box:fill-box;transform-origin:center;opacity:0;animation:pk 1.5s ease-out infinite}
.pk.b{animation-delay:.5s;--dx:0px}
.pk.a{animation-delay:0s;--dx:-12px}
.pk.c{animation-delay:1s;--dx:12px}
.msg{font-size:1.02em;color:rgba(255,255,255,.9);min-height:1.4em;transition:opacity .16s;text-align:center}
.msg.swap{opacity:0}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes pk{0%{transform:translate(0,6px) scale(.4);opacity:0}15%{opacity:1}100%{transform:translate(var(--dx,0),-28px) rotate(90deg) scale(1);opacity:0}}

/* ---------- barra de controles (vidro) ---------- */
.controls{position:absolute;left:50%;bottom:max(var(--bm),env(safe-area-inset-bottom));z-index:40;width:min(var(--barw),calc(100% - 2 * var(--bm) - env(safe-area-inset-left) - env(safe-area-inset-right)));padding:2px 10px 6px;border-radius:20px;background:rgba(18,18,22,.8);border:1px solid var(--line);box-shadow:0 12px 40px rgba(0,0,0,.45);display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"prow prow prow" "cl . cr";align-items:center;opacity:0;pointer-events:none;transform:translate(-50%,12px);transition:opacity .3s var(--ease),transform .3s var(--ease)}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.controls{background:var(--glass)}}
#app.is-ui .controls{opacity:1;pointer-events:auto;transform:translate(-50%,0)}
#app[data-phase="resume"] .controls,#app[data-phase="error"] .controls{opacity:0;pointer-events:none}
#app.is-soft .controls,#app.is-soft .top,#app.is-soft .gtop,#app.is-soft .gbot{transition-duration:.9s}
.cl{grid-area:cl;display:flex;align-items:center}
.cr{grid-area:cr;display:flex;align-items:center}
.prow{grid-area:prow;display:flex;align-items:center}
.prow>*+*{margin-left:10px}
.tm{font-size:.95em;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.92);min-width:2.6em;white-space:nowrap}
#cur{text-align:right}
#rem{text-align:left;color:rgba(255,255,255,.7)}
.prog{position:relative;flex:1;height:30px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.track{position:relative;width:100%;height:4px;border-radius:3px;background:rgba(255,255,255,.22);overflow:hidden;transition:height .12s}
.prog.drag .track{height:7px}
.buf,.fill,.hover{position:absolute;left:0;top:0;bottom:0;width:0}
.buf{background:rgba(255,255,255,.3)}
.fill{background:var(--accent);z-index:1}
.hover{display:none;background:rgba(255,255,255,.25)}
.thumb{position:absolute;top:50%;left:0;width:15px;height:15px;margin:-7.5px 0 0 -7.5px;border-radius:50%;background:var(--accent);opacity:0;transform:scale(.4);transition:opacity .12s,transform .12s;pointer-events:none;box-shadow:0 0 0 3px rgba(0,0,0,.3)}
.prog.drag .thumb{opacity:1;transform:scale(1.15)}
.tip{position:absolute;bottom:34px;left:0;transform:translateX(-50%);padding:5px 10px;border-radius:10px;background:rgba(12,12,14,.92);border:1px solid var(--line);font-size:.95em;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s}
.prog.drag .tip{opacity:1}
@media (hover:hover){
  .prog:hover .track{height:7px}
  .prog:hover .hover{display:block}
  .prog:hover .tip{opacity:1}
  .prog:hover .thumb{opacity:1;transform:scale(1)}
}
.vol{display:flex;align-items:center}
.vol input{width:0;opacity:0;transition:width .2s,opacity .2s,margin .2s;accent-color:var(--accent);cursor:pointer;height:4px}
.vol:hover input,.vol:focus-within input{width:78px;opacity:1;margin:0 8px 0 2px}
.i-exit{display:none}
#app.is-fs .i-exit{display:block}
#app.is-fs .i-enter{display:none}
#btnBack,#btnFwd,.vol{display:none}

/* ---------- menu de configurações ---------- */
.menu{position:absolute;z-index:70;right:10px;top:calc(var(--toph) + 2px);width:min(310px,calc(100% - 20px));max-height:calc(100% - var(--toph) - 90px);overflow:auto;padding:8px;border-radius:18px;background:rgba(22,22,26,.97);border:1px solid var(--line);box-shadow:0 14px 40px rgba(0,0,0,.55);opacity:0;visibility:hidden;transform:translateY(-8px) scale(.97);transform-origin:top right;transition:opacity .18s,transform .18s,visibility 0s .18s;-webkit-overflow-scrolling:touch}
.menu.open{opacity:1;visibility:visible;transform:none;transition-delay:0s}
.menu h3{font-size:.78em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.55);padding:8px 10px 6px}
.chips{display:flex;flex-wrap:wrap;padding:0 4px 6px}
.chip{margin:3px;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.09);font-size:.95em;transition:background .15s}
.chip:hover{background:rgba(255,255,255,.18)}
.chip[aria-checked=true]{background:var(--accent);color:#fff;font-weight:700}
.mi{display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px;border-radius:12px;text-align:left}
.mi:hover{background:rgba(255,255,255,.09)}
.mi small{display:block;font-size:.82em;color:rgba(255,255,255,.55);margin-top:1px}
.mi[aria-checked=true]{color:var(--accent);font-weight:700}
.mi svg{width:18px;height:18px;opacity:0;margin-left:10px}
.mi[aria-checked=true] svg{opacity:1}
.sw{width:42px;height:24px;border-radius:999px;background:rgba(255,255,255,.2);position:relative;flex:none;transition:background .2s;margin-left:12px}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s}
[aria-checked=true]>.sw,[aria-pressed=true]>.sw{background:var(--accent)}
[aria-checked=true]>.sw::after,[aria-pressed=true]>.sw::after{transform:translateX(18px)}

/* ---------- painéis (cenas, ficha, modos) ---------- */
.drawer{position:absolute;z-index:60;top:0;right:0;bottom:0;width:min(430px,46%);display:flex;flex-direction:column;background:rgba(14,14,18,.97);border-left:1px solid var(--line);transform:translateX(104%);visibility:hidden;transition:transform .35s var(--ease),visibility 0s .35s}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.drawer{background:rgba(14,14,18,.84)}}
#app:not([data-panel=""]) .drawer{transform:none;visibility:visible;transition-delay:0s}
.dh{display:flex;align-items:center;padding:max(12px,env(safe-area-inset-top)) 8px 8px 18px;flex:none}
.dh h2{flex:1;font-size:1.25em;font-weight:700}
.dbody{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:4px 16px calc(24px + env(safe-area-inset-bottom))}
.dsec{display:none}
#app[data-panel="scenes"] #pScenes,#app[data-panel="info"] #pInfo,#app[data-panel="modes"] #pModes{display:block}
.sub{font-size:.92em;color:rgba(255,255,255,.6);margin:0 0 12px}

/* mapa das cenas */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));grid-gap:10px;align-content:start;grid-auto-rows:min-content}
.sc{position:relative;display:block;width:100%;height:0;padding-top:56.25%;border-radius:12px;overflow:hidden;background:#222;border:2px solid transparent;transition:transform .15s,border-color .15s}
.sc:hover{transform:scale(1.03)}
.sc.on{border-color:var(--accent)}
.sc canvas{position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;transition:opacity .35s}
.sc.has canvas{opacity:1}
.sc:not(.has)::after{content:"";position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.08) 50%,transparent 70%);background-size:200% 100%;animation:sh 1.4s linear infinite}
.grid.done .sc:not(.has)::after{display:none}
.sc .t{position:absolute;left:6px;bottom:6px;z-index:1;padding:2px 7px;border-radius:7px;background:rgba(0,0,0,.75);font-size:.88em;font-weight:600;font-variant-numeric:tabular-nums}
@keyframes sh{from{background-position:200% 0}to{background-position:-200% 0}}

/* ficha do filme */
.fhead{display:flex;align-items:flex-start;margin-bottom:14px}
.fhead>*+*{margin-left:14px}
.fpost{width:34%;max-width:130px;flex:none;position:relative;height:0;padding-top:min(51%,195px);border-radius:12px;overflow:hidden;background:#222 center/cover no-repeat;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.ftit{font-size:1.3em;font-weight:700;line-height:1.2;margin-bottom:8px}
.tags{display:flex;flex-wrap:wrap;margin:-3px}
.tag{margin:3px;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.1);font-size:.9em;white-space:nowrap}
.tag.age{background:var(--accent);font-weight:700}
.fsyn{line-height:1.6;color:rgba(255,255,255,.88);margin-bottom:16px;font-size:1.02em;white-space:pre-line}
.fh3{font-size:.8em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.55);margin:14px 0 8px}
.cast{display:flex;overflow-x:auto;padding-bottom:6px;-webkit-overflow-scrolling:touch}
.cast>*+*{margin-left:12px}
.ci{width:68px;flex:none;text-align:center}
.ci i{display:block;width:60px;height:60px;margin:0 auto 6px;border-radius:50%;background:#2a2a30 center/cover no-repeat;font-style:normal;line-height:60px;font-weight:700;font-size:1.3em;color:#888}
.ci span{display:block;font-size:.82em;line-height:1.25;color:rgba(255,255,255,.8);word-break:break-word}
.fend{margin-top:14px;padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.07)}
.sk{height:14px;border-radius:7px;margin:10px 0;background:linear-gradient(100deg,rgba(255,255,255,.06) 30%,rgba(255,255,255,.14) 50%,rgba(255,255,255,.06) 70%);background-size:200% 100%;animation:sh 1.4s linear infinite}
.lnk{display:inline-block;margin-top:12px;padding:9px 16px;border-radius:999px;background:rgba(255,255,255,.12);font-weight:600}

/* guia de modos */
.mode{display:flex;align-items:center;width:100%;padding:13px 14px;margin-bottom:10px;border-radius:16px;background:rgba(255,255,255,.07);border:1px solid transparent;text-align:left;transition:background .15s,border-color .15s}
.mode:hover{background:rgba(255,255,255,.12)}
.mode[aria-pressed=true]{border-color:var(--accent);background:rgba(255,255,255,.1)}
.mode>svg{width:30px;height:30px;margin-right:14px;color:var(--accent)}
.mode .mt{flex:1;min-width:0}
.mode b{display:block;font-size:1.1em;margin-bottom:2px}
.mode span.d{display:block;font-size:.9em;line-height:1.35;color:rgba(255,255,255,.65)}
.pbtn,.gbtn{display:inline-flex;align-items:center;justify-content:center;padding:11px 22px;border-radius:999px;font-weight:700;transition:filter .15s,transform .15s,background .15s}
.pbtn{background:var(--accent);color:#fff}
.gbtn{background:rgba(255,255,255,.13)}
.pbtn:hover{filter:brightness(1.12)}
.gbtn:hover{background:rgba(255,255,255,.22)}
.pbtn:active,.gbtn:active{transform:scale(.97)}
.pbtn svg,.gbtn svg{width:20px;height:20px;margin-right:6px}
.keys{margin-top:8px;font-size:.88em;line-height:1.9;color:rgba(255,255,255,.7)}
kbd{display:inline-block;min-width:1.8em;padding:1px 7px;margin:0 2px;border-radius:6px;background:rgba(255,255,255,.14);text-align:center;font-family:inherit;font-weight:600;color:#fff}

/* ---------- cartões (continuar, erro, próximo filme) ---------- */
.ovl{position:absolute;top:0;right:0;bottom:0;left:0;display:none;align-items:center;justify-content:center;padding:14px;overflow:auto}
.card{width:100%;max-width:440px;margin:auto;padding:22px 24px;border-radius:24px;background:rgba(18,18,22,.9);border:1px solid var(--line);box-shadow:0 20px 60px rgba(0,0,0,.6);text-align:center;animation:rise .4s var(--ease) both}
@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){.card{background:rgba(18,18,22,.72)}}
.card>*+*{margin-top:12px}
.card h2{font-size:1.45em;line-height:1.2}
.card p{color:rgba(255,255,255,.72);line-height:1.5}
.cta{display:flex;flex-wrap:wrap;justify-content:center;margin:-5px}
.cta>*{margin:5px}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
#resume{z-index:80;background:rgba(0,0,0,.35)}
#app[data-phase="resume"] #resume{display:flex}
#err{z-index:95;background:rgba(0,0,0,.88)}
#app[data-phase="error"] #err{display:flex}
#err img{display:block;margin:0 auto;width:min(300px,70%);max-height:30vh;object-fit:cover;border-radius:16px}
.stg{display:inline-block;padding:3px 11px;border-radius:999px;background:rgba(255,255,255,.09);font-size:.85em;color:rgba(255,255,255,.65)}

/* próximo filme */
#next{z-index:75;background:rgba(0,0,0,.72)}
#app.is-next #next{display:flex}
#app.is-next .controls,#app.is-next .top,#app.is-next .gtop,#app.is-next .gbot{opacity:0!important;pointer-events:none!important}
#next .card{max-width:620px;text-align:left}
.nx{display:flex;align-items:flex-start}
.nx>*+*{margin-left:16px}
.nxp{width:30%;max-width:160px;flex:none;position:relative;height:0;padding-top:min(45%,240px);border-radius:14px;overflow:hidden;background:#222 center/cover no-repeat;box-shadow:0 10px 30px rgba(0,0,0,.5)}
.nxt{flex:1;min-width:0}
.nxt .why{display:inline-block;padding:3px 11px;border-radius:999px;background:rgba(255,255,255,.1);font-size:.82em;color:rgba(255,255,255,.8);margin-bottom:8px}
.nxt h2{font-size:1.5em;margin-bottom:6px}
.nxt .meta{font-size:.92em;color:rgba(255,255,255,.62);margin-bottom:8px}
.nxt .syn{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5;color:rgba(255,255,255,.82)}
.nxa{display:flex;flex-wrap:wrap;margin:14px -5px -5px}
.nxa>*{margin:5px}
.nxl{display:flex;margin-top:14px;overflow-x:auto}
.nxl>*+*{margin-left:8px}
.alt{width:56px;height:84px;flex:none;border-radius:8px;background:#222 center/cover no-repeat;border:2px solid transparent;opacity:.7;transition:opacity .15s,border-color .15s}
.alt:hover{opacity:1}
.alt.on{opacity:1;border-color:var(--accent)}
.nxh{display:flex;align-items:center;justify-content:space-between;font-size:.82em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:12px}
.nxh .btn{width:36px;height:36px;margin:-6px -8px -6px 0}

/* ---------- aviso rápido ---------- */
.toast{position:absolute;top:calc(var(--toph) + 8px);left:50%;z-index:90;transform:translate(-50%,-8px);padding:8px 16px;border-radius:999px;background:rgba(20,20,24,.9);border:1px solid var(--line);font-weight:500;white-space:nowrap;max-width:92%;overflow:hidden;text-overflow:ellipsis;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
.toast.on{opacity:1;transform:translate(-50%,0)}

/* ---------- modos ---------- */
#app.m-cinema .ttl,#app.m-cinema .clock,#app.m-cinema .gtop,#app.m-cinema .gbot{opacity:0!important;visibility:hidden}
#app.m-cinema .controls{background:rgba(10,10,12,.5);box-shadow:none;border-color:transparent}
#app.m-read video::cue{font-size:150%;line-height:1.3;color:#fff;background:rgba(0,0,0,.82);font-family:Roboto,Arial,sans-serif}

/* ---------- layouts adaptativos ---------- */
/* telefone em pé: ícones no topo, barra enxuta embaixo */
#app[data-lay="phone"] .clock{display:none}
#app[data-lay="phone"][data-sz="m"] .clock,#app[data-lay="phone"][data-sz="l"] .clock{display:block}
#app[data-lay="phone"] .drawer,#app[data-lay="tiny"] .drawer{top:auto;left:0;width:auto;height:min(76%,600px);border-left:0;border-top:1px solid var(--line);border-radius:22px 22px 0 0;transform:translateY(104%)}
#app[data-lay="phone"]:not([data-panel=""]) .drawer,#app[data-lay="tiny"]:not([data-panel=""]) .drawer{transform:none}
#app[data-lay="tiny"] .drawer{height:92%}
#app[data-lay="phone"] .grid{grid-template-columns:repeat(2,1fr)}
#app[data-lay="phone"] .nx{flex-direction:column;align-items:center;text-align:center}
#app[data-lay="phone"] .nx>*+*{margin-left:0;margin-top:14px}
#app[data-lay="phone"] .nxp{width:34%;padding-top:51%}
#app[data-lay="phone"] .nxa{justify-content:center}

/* telefone deitado / janelas baixas: tudo numa linha só */
#app[data-lay="phone-l"] .controls,#app[data-lay="tiny"] .controls{grid-template-columns:auto 1fr auto;grid-template-areas:"cl prow cr";padding:2px 8px;border-radius:16px}
#app[data-lay="phone-l"] .drawer{width:min(54%,440px)}
#app[data-lay="phone-l"] .gtop{height:90px}
#app[data-lay="phone-l"] .card{padding:14px 18px}
#app[data-lay="phone-l"] .nxp{width:20%;padding-top:30%}
#app[data-lay="phone-l"] .nxl{display:none}
#app[data-lay="phone-l"] .nxt .syn{-webkit-line-clamp:2}
#app[data-lay="phone-l"] .fpost{display:none}

/* janelinha minúscula (iframe pequeno) */
#app[data-lay="tiny"] .clock,#app[data-lay="tiny"] .endat,#app[data-lay="tiny"] #btnInfo,#app[data-lay="tiny"] #btnScenes,#app[data-lay="tiny"] #btnModes,#app[data-lay="tiny"] #mBack,#app[data-lay="tiny"] #mFwd,#app[data-lay="tiny"] #mBack5,#app[data-lay="tiny"] #btnPip,#app[data-lay="tiny"] #btnCast,#app[data-lay="tiny"] #rem{display:none!important}
#app[data-lay="tiny"] .ttl h1{font-size:.95em}
#app[data-lay="tiny"] .nxl,#app[data-lay="tiny"] .nxp,#app[data-lay="tiny"] .nxt .syn{display:none}

/* tablet e computador: botões ±10 e volume na barra */
#app[data-lay="tablet"] #btnBack,#app[data-lay="tablet"] #btnFwd,#app[data-lay="desktop"] #btnBack,#app[data-lay="desktop"] #btnFwd,#app[data-lay="desktop"] .vol,#app[data-lay="tablet"] .vol{display:flex}
#app[data-lay="tablet"] .vol .btn,#app[data-lay="desktop"] .vol .btn{display:flex}
#app[data-lay="desktop"] .drawer{width:min(460px,34%)}
#app[data-sz="xl"] .drawer,#app[data-sz="xxl"] .drawer{width:min(560px,32%)}
#app[data-sz="xxl"] .grid{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
/* tela ultra larga (21:9 e além) */
#app[data-wide="1"] .controls{width:min(var(--barw),60%)}
#app[data-wide="1"] .drawer{width:min(500px,26%)}
#app[data-wide="1"][data-lay="phone-l"] .controls{width:min(900px,calc(100% - 2 * var(--bm)))}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
`;

// ============================================================================
//  JS DO PLAYER (roda no navegador)
//  Obs: sem crases e sem ${ } aqui dentro (é um String.raw).
//  Um único objeto de estado (S) + render() → a interface nunca mostra estados contraditórios.
// ============================================================================
const CLIENT_JS = String.raw`
(function(){
  'use strict';
  var C = window.__PF || {};
  function $(id){ return document.getElementById(id); }
  var app=$('app'), rig=$('rig'), video=$('v'), controls=$('controls'), prog=$('prog'), fill=$('fill'), buf=$('buf'),
      hoverEl=$('hover'), thumbEl=$('thumb'), tip=$('tip'), curEl=$('cur'), remEl=$('rem'), msgEl=$('msg'),
      toastEl=$('toast'), menu=$('menu'), drawer=$('drawer'), tapEl=$('tap'), fxL=$('fxL'), fxR=$('fxR'),
      clockEl=$('clock'), endEl=$('endAt'), btnSet=$('btnSet'), btnInfo=$('btnInfo'), btnScenes=$('btnScenes'),
      btnModes=$('btnModes'), btnPip=$('btnPip'), btnCast=$('btnCast'), btnFs=$('btnFs'), btnMute=$('btnMute'),
      volIn=$('vol'), dTitle=$('dTitle'), scGrid=$('scGrid');

  var MSGS=['Preparando a sessão…','Ajustando o projetor…','Quase na primeira cena…'];
  var SPEEDS=[0.5,0.75,1,1.25,1.5,1.75,2];
  var KPOS='pf:pos:'+C.id, KVOL='pf:vol', KMODES='pf:modes', KTELE='pf:tele', KHIST='pf:hist', KSAVED='pf:saved';

  // ---------- utilidades ----------
  function fmt(t){
    if(!isFinite(t)) return '0:00';
    t=Math.max(0,Math.floor(t));
    var h=Math.floor(t/3600), m=Math.floor((t%3600)/60), s=t%60;
    if(h) return h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
    return m+':'+(s<10?'0':'')+s;
  }
  function hhmm(d){ try{ return d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }catch(e){ return d.getHours()+':'+('0'+d.getMinutes()).slice(-2); } }
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
  function jget(k,d){ try{ var v=JSON.parse(lsGet(k)); return v==null?d:v; }catch(e){ return d; } }
  function norm(s){
    s=String(s||'').toLowerCase();
    try{ s=s.normalize('NFD').replace(/[̀-ͯ]/g,''); }catch(e){}
    return s.replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  }
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
  function svgUse(id){ var s=document.createElementNS('http://www.w3.org/2000/svg','svg'); var u=document.createElementNS('http://www.w3.org/2000/svg','use'); u.setAttribute('href','#i-'+id); s.setAttribute('aria-hidden','true'); s.setAttribute('focusable','false'); s.appendChild(u); return s; }
  function focusEl(n){ if(!n) return; try{ n.focus({preventScroll:true}); }catch(e){ try{ n.focus(); }catch(_){} } }
  function safeUrl(u){ return /^https?:\/\//i.test(u||'') ? u : ''; }
  function bg(node,u){ u=safeUrl(u); if(u) node.style.backgroundImage='url('+JSON.stringify(u)+')'; }
  var _g={};
  function guard(k,ms){ var n=Date.now(); if(_g[k] && n-_g[k]<ms) return false; _g[k]=n; return true; }
  function postParent(msg){ try{ if(window.parent && window.parent!==window) window.parent.postMessage(msg,'*'); }catch(e){} }
  var toastT=0;
  function toast(t){
    toastEl.textContent=t; toastEl.classList.add('on');
    clearTimeout(toastT); toastT=setTimeout(function(){ toastEl.classList.remove('on'); },1900);
  }

  // ---------- teste de compatibilidade: só mostra o que funciona ----------
  var UA=navigator.userAgent||'';
  var isIOS=/iPad|iPhone|iPod/.test(UA)||(navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  var isIPhone=/iPhone|iPod/.test(UA);
  var isApple=isIOS||(/Safari/.test(UA) && !/Chrome|Chromium|Android|Edg|OPR|Firefox/.test(UA));
  var isTouch=('ontouchstart' in window)||(navigator.maxTouchPoints>0);
  var CAP={
    fs: !!(app.requestFullscreen||app.webkitRequestFullscreen),
    vfs: !!video.webkitEnterFullscreen,
    pip: !!(document.pictureInPictureEnabled && video.requestPictureInPicture) || !!(video.webkitSupportsPresentationMode && video.webkitSupportsPresentationMode('picture-in-picture')),
    cast: !!(video.remote && video.remote.watchAvailability) || !!window.WebKitPlaybackTargetAvailabilityEvent,
    lock: !!(window.screen && screen.orientation && screen.orientation.lock),
    mse: !!(window.MediaSource||window.ManagedMediaSource),
    nativeHls: !!video.canPlayType('application/vnd.apple.mpegurl'),
    wake: !!(navigator.wakeLock && navigator.wakeLock.request),
    media: !!navigator.mediaSession
  };
  btnPip.hidden=!CAP.pip;
  btnFs.hidden=!(CAP.fs||CAP.vfs||(window.top===window && isTouch));

  // ---------- estado central ----------
  // phase: resume | boot | playing | paused | ended | error
  var S={phase:'boot',started:false,buffering:false,ui:true,panel:'',menu:false,napReady:false,dragging:false,
         pip:false,fs:false,pfs:false,rot:false,flip:false,manualRot:false,locked:false,lockPending:false,
         waitGesture:false,nextClosed:false,soft:false,tele:false};
  var modes={cinema:false,night:false,read:false};
  var fit='contain';
  var hideT=0, napT=0, loadT=0, stallT=0, tStart=Date.now(), stalls=0, engName='';
  var hls=null, netTries=0, mediaTries=0, panelsClosedAt=0, savedPos=0, pendingPlay=false, watchedMarked=false, preloaded=false;

  function setCls(n,on){ on=!!on; if(app.classList.contains(n)!==on) app.classList.toggle(n,on); }
  function render(){
    var ph=S.phase;
    if(app.getAttribute('data-phase')!==ph) app.setAttribute('data-phase',ph);
    if(app.getAttribute('data-panel')!==S.panel) app.setAttribute('data-panel',S.panel);
    var forced = ph!=='playing' || !!S.panel || S.menu || S.dragging;
    var buffering = ph==='boot' || (S.buffering && (ph==='playing'||ph==='paused'));
    setCls('is-ui', forced||S.ui);
    setCls('is-buffering', buffering);
    setCls('is-started', S.started);
    setCls('is-nap', ph==='paused' && S.started && S.napReady && !S.panel && !S.menu && !S.pip && !buffering && !modes.cinema);
    setCls('is-pip', S.pip);
    setCls('is-fs', S.fs||S.pfs);
    setCls('is-rot', S.rot);
    setCls('is-flip', S.rot && S.flip);
    setCls('is-soft', S.soft);
    setCls('is-next', ph==='ended' && !S.nextClosed);
    setCls('m-cinema', modes.cinema); setCls('m-night', modes.night); setCls('m-read', modes.read);
    var main=$('mPlay');
    var lab = ph==='ended' ? 'Assistir de novo' : (video.paused ? 'Reproduzir' : 'Pausar');
    if(main.getAttribute('aria-label')!==lab){ main.setAttribute('aria-label',lab); $('btnPlay').setAttribute('aria-label',lab); }
    btnSet.setAttribute('aria-expanded',S.menu?'true':'false');
    btnInfo.setAttribute('aria-expanded',S.panel==='info'?'true':'false');
    btnScenes.setAttribute('aria-expanded',S.panel==='scenes'?'true':'false');
    btnModes.setAttribute('aria-expanded',S.panel==='modes'?'true':'false');
    drawer.setAttribute('aria-hidden',S.panel?'false':'true');
    menu.classList.toggle('open',S.menu);
  }

  [app,rig].forEach(function(n){ n.addEventListener('scroll',function(){ n.scrollTop=0; n.scrollLeft=0; }); });

  // ---------- tamanho da tela → layout adaptativo ----------
  function measure(){
    var w=rig.clientWidth, h=rig.clientHeight;
    if(!w||!h) return;
    var lay;
    if(w<300||h<200) lay='tiny';
    else if(h<470 && w>h) lay='phone-l';
    else if(w<640) lay='phone';
    else if(w<1100) lay='tablet';
    else lay='desktop';
    var sz = w<480?'s':(w<900?'m':(w<1500?'l':(w<2200?'xl':'xxl')));
    var wide = ((w/h)>=2 && w>=1100) ? '1' : '0';
    if(app.getAttribute('data-lay')!==lay) app.setAttribute('data-lay',lay);
    if(app.getAttribute('data-sz')!==sz) app.setAttribute('data-sz',sz);
    if(app.getAttribute('data-wide')!==wide) app.setAttribute('data-wide',wide);
    app.style.setProperty('--rh',h+'px');
    app.style.setProperty('--rw',w+'px');
    applyFit();
  }
  if(window.ResizeObserver){ try{ new ResizeObserver(function(){ measure(); }).observe(rig); }catch(e){} }
  window.addEventListener('resize',function(){ measure(); updateRot(); });
  window.addEventListener('orientationchange',function(){ setTimeout(function(){ measure(); updateRot(); },200); });

  // ---------- ícone play/pause com morph ----------
  var PLAYP =[8,5, 13.5,8.4, 13.5,15.6, 8,19,    13.5,8.4, 19,12, 19,12, 13.5,15.6];
  var PAUSEP=[6,5, 10,5,     10,19,     6,19,    14,5,     18,5, 18,19, 14,19];
  function pathOf(a){
    return 'M'+a[0]+' '+a[1]+'L'+a[2]+' '+a[3]+'L'+a[4]+' '+a[5]+'L'+a[6]+' '+a[7]+'Z'+
           'M'+a[8]+' '+a[9]+'L'+a[10]+' '+a[11]+'L'+a[12]+' '+a[13]+'L'+a[14]+' '+a[15]+'Z';
  }
  var mphs=document.querySelectorAll('.mph'), mCur=0, mFrom=0, mTo=0, mT0=0, mRaf=0;
  function mDraw(k){
    var a=[], i, d;
    for(i=0;i<16;i++) a.push(Math.round((PLAYP[i]+(PAUSEP[i]-PLAYP[i])*k)*100)/100);
    d=pathOf(a);
    for(i=0;i<mphs.length;i++) mphs[i].setAttribute('d',d);
  }
  function morphTo(k){
    if(mTo===k && mRaf) return;
    cancelAnimationFrame(mRaf);
    mFrom=mCur; mTo=k; mT0=performance.now();
    function step(now){
      var p=Math.min(1,(now-mT0)/200);
      var e=p<.5?2*p*p:1-Math.pow(-2*p+2,2)/2;
      mCur=mFrom+(mTo-mFrom)*e;
      mDraw(mCur);
      if(p<1) mRaf=requestAnimationFrame(step); else mRaf=0;
    }
    mRaf=requestAnimationFrame(step);
  }
  function syncIcons(){ morphTo(video.paused?0:1); }

  // ---------- mensagens do carregamento (seguem o estado real) ----------
  var msgIdx=0, msgAt=Date.now(), msgT=0;
  function applyMsg(i){
    msgIdx=i; msgAt=Date.now(); msgEl.classList.add('swap');
    setTimeout(function(){ msgEl.textContent=MSGS[i]; msgEl.classList.remove('swap'); },160);
  }
  function setMsg(i){
    if(S.started){ msgEl.textContent='Carregando…'; return; }
    if(i<=msgIdx) return;
    clearTimeout(msgT);
    msgT=setTimeout(function(){ applyMsg(i); }, Math.max(0,1000-(Date.now()-msgAt)));
  }

  // ---------- visibilidade da interface ----------
  function uiLocked(){ return S.phase!=='playing' || !!S.panel || S.menu || S.dragging; }
  function bumpUI(){
    S.ui=true; clearTimeout(hideT);
    if(!uiLocked()) hideT=setTimeout(hideUI, modes.cinema?1800:3000);
    render();
  }
  function hideUI(){
    if(uiLocked()) return;
    if(window.matchMedia && matchMedia('(hover:hover)').matches && (controls.matches(':hover')||$('top').matches(':hover'))){ hideT=setTimeout(hideUI,1200); return; }
    S.ui=false; render();
  }

  // ---------- reproduzir / pausar ----------
  function tryPlay(){
    var p; pendingPlay=true;
    try{ p=video.play(); }catch(e){ pendingPlay=false; }
    if(p && p.then){ p.then(function(){ pendingPlay=false; }, onPlayReject); } else pendingPlay=false;
  }
  function onPlayReject(err){
    pendingPlay=false;
    if(!err || err.name==='AbortError' || S.phase==='error') return;
    if(err.name==='NotSupportedError'){ showError('decodificacao','NotSupported'); return; }
    // autoplay bloqueado: espera o toque do espectador
    S.waitGesture=true; S.buffering=false;
    if(S.phase==='boot') S.phase='paused';
    bumpUI();
  }
  function toggle(){
    if(!guard('toggle',160)) return;
    if(video.paused||video.ended) tryPlay(); else video.pause();
  }
  function armNap(){
    clearTimeout(napT); S.napReady=false;
    napT=setTimeout(function(){ S.napReady=true; render(); },900);
  }

  // ---------- continuar de onde parou ----------
  function savePos(){
    var t=video.currentTime, d=video.duration;
    if(!S.started || !isFinite(t) || !isFinite(d) || d<=0) return;
    if(video.ended || d-t<90){ lsDel(KPOS); return; }
    if(t>=30) lsSet(KPOS,String(Math.floor(t)));
  }
  setInterval(function(){ if(!video.paused) savePos(); },5000);
  window.addEventListener('pagehide',function(){ savePos(); track('stalls',{stalls:stalls}); if(hls){ try{ hls.destroy(); }catch(e){} } });
  document.addEventListener('visibilitychange',function(){
    if(document.hidden) savePos(); else if(S.phase==='playing') wakeOn();
  });

  // ---------- telemetria técnica anônima (só se o espectador autorizar) ----------
  S.tele = !!C.tele && lsGet(KTELE)==='1';
  function track(ev,x){
    if(!S.tele) return;
    var o={ev:ev,eng:engName,lay:app.getAttribute('data-lay'),v:1}, k;
    if(x) for(k in x) o[k]=x[k];
    try{ navigator.sendBeacon(location.pathname,new Blob([JSON.stringify(o)],{type:'text/plain'})); }catch(e){}
  }

  // ---------- erros por etapa ----------
  var STAGES={
    biblioteca:['Componente de vídeo','Não foi possível carregar o componente de vídeo. Verifique a conexão e tente de novo.'],
    fonte:['Fonte','O link do filme expirou ou não pôde ser autorizado.'],
    carregamento:['Carregamento','A conexão com o vídeo falhou ou ficou lenta demais.'],
    decodificacao:['Decodificação','Este aparelho ou navegador não conseguiu decodificar o vídeo.'],
    reproducao:['Reprodução','O navegador bloqueou a reprodução do vídeo.']
  };
  function showError(stage,code){
    if(S.phase==='error') return;
    clearTimeout(loadT); clearTimeout(stallT); clearTimeout(napT);
    savePos();
    try{ video.pause(); }catch(e){}
    wakeOff();
    S.panel=''; S.menu=false; S.buffering=false; S.napReady=false;
    S.phase='error';
    var st=STAGES[stage]||STAGES.carregamento;
    $('errMsg').textContent=st[1]+' O link pode ter expirado — tente novamente para gerar um novo.';
    $('errStage').textContent='Etapa: '+st[0]+(code?' · '+String(code).slice(0,40):'');
    track('error',{stage:stage,code:String(code||'').slice(0,40)});
    render();
    setTimeout(function(){ focusEl($('btnRetry')); },60);
  }
  $('btnRetry').addEventListener('click',function(){ location.reload(); });

  // ---------- fonte de vídeo: nativo / hls.js (com vários CDNs) ----------
  function pickEngine(){
    if(!C.isHls) return 'native';
    var e=C.engine||'auto';
    if(e==='native') return CAP.nativeHls?'native':(CAP.mse?'hlsjs':'none');
    if(e==='hlsjs') return CAP.mse?'hlsjs':(CAP.nativeHls?'native':'none');
    if(isApple && CAP.nativeHls) return 'native';
    if(CAP.mse) return 'hlsjs';
    return CAP.nativeHls?'native':'none';
  }
  function loadHls(done){
    if(window.Hls){ done(true); return; }
    var list=(C.hlsCdns||[]).slice(), i=0;
    (function next(){
      if(i>=list.length){ done(false); return; }
      var s=document.createElement('script'), fired=false, to;
      function fail(){ if(fired) return; fired=true; clearTimeout(to); try{ s.parentNode.removeChild(s); }catch(e){} i++; next(); }
      s.onload=function(){ if(fired) return; fired=true; clearTimeout(to); if(window.Hls) done(true); else { i++; next(); } };
      s.onerror=fail;
      to=setTimeout(fail,9000);
      s.async=true; s.src=list[i]; document.head.appendChild(s);
    })();
  }
  function seekOnce(t){
    if(!(t>0)) return;
    function f(){ video.removeEventListener('loadedmetadata',f); try{ video.currentTime=t; }catch(e){} }
    video.addEventListener('loadedmetadata',f);
  }
  function attachNative(startAt,autoplay){
    engName='native';
    video.src=C.url; seekOnce(startAt);
    if(autoplay) tryPlay();
  }
  function attachHls(startAt,autoplay){
    engName='hlsjs';
    var small = isTouch || (navigator.deviceMemory && navigator.deviceMemory<=2);
    hls=new Hls({
      enableWorker:true,
      capLevelToPlayerSize:true,          // não baixa 1080p em tela pequena
      startLevel:-1,                      // qualidade automática
      maxBufferLength: small?30:50,
      maxMaxBufferLength: small?60:120,
      backBufferLength: small?30:90,      // guarda o que já passou: voltar uma cena recente não trava
      startPosition: startAt>0?startAt:-1
    });
    hls.on(Hls.Events.MANIFEST_PARSED,function(){ setMsg(1); if(autoplay) tryPlay(); });
    hls.on(Hls.Events.FRAG_LOADED,function(){ netTries=0; });
    hls.on(Hls.Events.ERROR,function(_,d){
      if(!d || !d.fatal) return;
      if(d.type===Hls.ErrorTypes.NETWORK_ERROR){
        if(netTries<3){ netTries++; setTimeout(function(){ try{ hls.startLoad(); }catch(e){} },800*netTries); return; }
        showError('carregamento',d.details); return;
      }
      if(d.type===Hls.ErrorTypes.MEDIA_ERROR){
        if(mediaTries<2){ mediaTries++; try{ if(mediaTries===2) hls.swapAudioCodec(); hls.recoverMediaError(); }catch(e){} return; }
        showError('decodificacao',d.details); return;
      }
      showError('carregamento',d.details||d.type);
    });
    hls.loadSource(C.url);
    hls.attachMedia(video);
  }
  function startSource(startAt,autoplay){
    S.phase='boot'; S.buffering=true; S.started=false; render();
    clearTimeout(loadT);
    loadT=setTimeout(function(){ showError('carregamento','timeout'); },45000);
    tStart=Date.now();
    var eng=pickEngine();
    if(eng==='native') attachNative(startAt,autoplay);
    else if(eng==='hlsjs'){
      loadHls(function(ok){
        if(!ok){ if(CAP.nativeHls) attachNative(startAt,autoplay); else showError('biblioteca','cdn'); return; }
        if(!window.Hls.isSupported()){ if(CAP.nativeHls) attachNative(startAt,autoplay); else showError('decodificacao','mse'); return; }
        attachHls(startAt,autoplay);
      });
    } else showError('decodificacao','sem-suporte');
  }

  // ---------- eventos do vídeo ----------
  var castWatching=false;
  video.addEventListener('loadedmetadata',function(){
    prog.setAttribute('aria-valuemax',String(Math.floor(video.duration)||0));
    setMsg(1); applyFit(); updTimes(); watchCast();
  });
  video.addEventListener('durationchange',function(){ updTimes(); });
  video.addEventListener('loadeddata',function(){ setMsg(2); });
  video.addEventListener('canplay',function(){
    clearTimeout(loadT); clearTimeout(stallT);
    if(S.buffering && video.readyState>=3){ S.buffering=false; }
    if(S.phase==='boot' && video.paused && !pendingPlay){ S.phase='paused'; S.waitGesture=true; }
    render();
  });
  video.addEventListener('play',function(){
    if(S.phase==='error') return;
    S.waitGesture=false; clearTimeout(napT); S.napReady=false;
    if(S.started){ S.phase='playing'; S.buffering=video.readyState<3; }
    else { S.phase='boot'; S.buffering=true; }
    syncIcons(); bumpUI();
  });
  video.addEventListener('playing',function(){
    clearTimeout(loadT); clearTimeout(stallT);
    if(!S.started){ S.started=true; track('start',{ms:Date.now()-tStart}); loadFichaSoon(); setTimeout(applyFit,50); }
    S.phase='playing'; S.buffering=false; S.waitGesture=false; S.nextClosed=false;
    syncIcons(); wakeOn(); bumpUI();
  });
  video.addEventListener('pause',function(){
    if(video.ended || S.phase==='error') return;
    S.phase='paused'; S.buffering=false;
    syncIcons(); wakeOff(); savePos();
    if(S.started) armNap();
    bumpUI();
  });
  video.addEventListener('waiting',function(){
    if(!S.started || S.phase==='error') return;
    S.buffering=true; stalls++; setMsg(1); render();
    clearTimeout(stallT);
    stallT=setTimeout(function(){ if(S.buffering) showError('carregamento','travado'); },45000);
  });
  video.addEventListener('seeking',function(){ if(S.started && video.readyState<3){ S.buffering=true; render(); } });
  video.addEventListener('seeked',function(){ if(video.readyState>=3){ S.buffering=false; clearTimeout(stallT); render(); } });
  video.addEventListener('ended',function(){
    lsDel(KPOS); markWatched();
    S.phase='ended'; S.buffering=false; S.nextClosed=false; S.napReady=false;
    syncIcons(); wakeOff(); computeNext(); renderNext(); bumpUI();
    loadFichaSoon();
  });
  video.addEventListener('error',function(){
    if(hls || S.phase==='error') return;
    var c=video.error?video.error.code:0;
    if(c===1) return;
    showError(c===2?'carregamento':'decodificacao','E'+c);
  });
  video.addEventListener('ratechange',function(){ updEnd(); });

  // ---------- progresso, tempo restante, "termina às", relógio ----------
  var lastSec=-1;
  function paintRatio(x){ fill.style.width=(x*100)+'%'; thumbEl.style.left=(x*100)+'%'; }
  function bufEnd(t){
    var b=video.buffered, i;
    for(i=0;i<b.length;i++){ if(t>=b.start(i)-0.3 && t<=b.end(i)+0.3) return b.end(i); }
    return b.length?b.end(b.length-1):0;
  }
  function updBuf(){
    var d=video.duration;
    if(d>0 && isFinite(d)) buf.style.width=(Math.min(1,bufEnd(video.currentTime||0)/d)*100)+'%';
  }
  function showTimes(t){
    var d=video.duration, ok=d>0&&isFinite(d);
    curEl.textContent=fmt(t);
    remEl.textContent=ok?'-'+fmt(Math.max(0,d-t)):'';
  }
  function updTimes(){
    var d=video.duration||0, t=video.currentTime||0;
    if(!S.dragging){ paintRatio(d?Math.min(1,t/d):0); showTimes(t); }
    updBuf(); updEnd();
  }
  function updEnd(){
    var d=video.duration, t=video.currentTime||0;
    var txt='';
    if(d>0 && isFinite(d) && S.phase!=='ended'){
      var rate=video.playbackRate||1;
      txt='Termina às '+hhmm(new Date(Date.now()+Math.max(0,d-t)/rate*1000))+(rate!==1?' ('+rateLabel(rate)+')':'');
    }
    if(endEl.textContent!==txt) endEl.textContent=txt;
  }
  function updClock(){ var t=hhmm(new Date()); if(clockEl.textContent!==t) clockEl.textContent=t; }
  updClock(); setInterval(function(){ updClock(); updEnd(); },15000);
  video.addEventListener('progress',updBuf);
  video.addEventListener('timeupdate',function(){
    updTimes();
    var s=Math.floor(video.currentTime||0);
    if(s!==lastSec){
      lastSec=s;
      prog.setAttribute('aria-valuenow',String(s));
      prog.setAttribute('aria-valuetext',fmt(video.currentTime)+' de '+fmt(video.duration));
      if(S.panel==='scenes') markScene();
      var d=video.duration;
      if(d>0){
        var r=video.currentTime/d;
        if(r>=0.6 && !preloaded){ preloaded=true; preloadRecs(); }
        if(r>=0.7) markWatched();
      }
    }
  });

  // ---------- barra de progresso (clique, arrastar, tooltip) ----------
  function localRatio(e,node){
    var r=node.getBoundingClientRect(), x;
    if(S.rot) x = S.flip ? (r.bottom-e.clientY)/r.height : (e.clientY-r.top)/r.height;
    else x=(e.clientX-r.left)/r.width;
    return Math.min(1,Math.max(0,x||0));
  }
  function moveTip(x){
    tip.textContent=fmt(x*(video.duration||0));
    var w=tip.offsetWidth, tw=prog.clientWidth, px=x*tw;
    px=Math.min(Math.max(tw-w/2,w/2),Math.max(w/2,px));
    tip.style.left=px+'px';
  }
  var dragRatio=0;
  prog.addEventListener('pointerdown',function(e){
    if(!video.duration || !isFinite(video.duration)) return;
    S.dragging=true; prog.classList.add('drag');
    clearTimeout(napT); S.napReady=false;
    try{ prog.setPointerCapture(e.pointerId); }catch(err){}
    var x=localRatio(e,prog); dragRatio=x; paintRatio(x); moveTip(x); showTimes(x*video.duration);
    bumpUI();
  });
  prog.addEventListener('pointermove',function(e){
    var x=localRatio(e,prog);
    hoverEl.style.width=(x*100)+'%';
    moveTip(x);
    if(S.dragging){ dragRatio=x; paintRatio(x); showTimes(x*(video.duration||0)); }
  });
  function endDrag(apply){
    if(!S.dragging) return;
    S.dragging=false; prog.classList.remove('drag');
    if(apply && video.duration) video.currentTime=dragRatio*video.duration;
    if(video.paused && S.started) armNap();
    bumpUI();
  }
  prog.addEventListener('pointerup',function(){ endDrag(true); });
  prog.addEventListener('pointercancel',function(){ endDrag(false); });
  prog.addEventListener('keydown',function(e){
    var k=e.key, d=video.duration||0;
    if(k==='ArrowLeft'||k==='ArrowRight'||k==='Home'||k==='End'){
      e.preventDefault(); e.stopPropagation();
      if(k==='ArrowLeft') seekBy(-5); else if(k==='ArrowRight') seekBy(5);
      else if(k==='Home') video.currentTime=0; else if(d) video.currentTime=Math.max(0,d-1);
      bumpUI();
    }
  });

  // ---------- pular ±10 s (círculo animado) ----------
  function seekBy(d){
    var t=(video.currentTime||0)+d, m=video.duration;
    if(isFinite(m)) t=Math.min(t,m-0.05);
    video.currentTime=Math.max(0,t);
  }
  var fxAcc={l:0,r:0}, fxT={l:0,r:0};
  function fx(z,sec){
    var node=(z==='l')?fxL:fxR;
    clearTimeout(fxT[z]);
    fxAcc[z]+=sec;
    node.querySelector('span').textContent=(z==='l'?'−':'+')+fxAcc[z]+' s';
    node.classList.remove('go'); void node.offsetWidth; node.classList.add('go');
    fxT[z]=setTimeout(function(){ fxAcc[z]=0; },900);
  }
  function skip(z,sec){ sec=sec||10; seekBy(z==='l'?-sec:sec); fx(z,sec); bumpUI(); }

  // ---------- toques: clique (mouse) / toque simples e duplo (celular) ----------
  function closePanels(){
    var any=S.menu||!!S.panel;
    if(S.menu) S.menu=false;
    if(S.panel) closePanel(true);
    if(any){ panelsClosedAt=Date.now(); render(); }
    return any;
  }
  function zoneOf(e){ var x=localRatio(e,rig); return x<0.35?'l':(x>0.65?'r':'c'); }
  function singleTap(){
    if(S.ui && !uiLocked()){ clearTimeout(hideT); S.ui=false; render(); }
    else bumpUI();
  }
  var lastPT='mouse', lastTap=0, lastZone='', tapTimer=0, chainZone='', chainT=0;
  tapEl.addEventListener('pointerdown',function(e){ lastPT=e.pointerType||'mouse'; });
  tapEl.addEventListener('click',function(){
    if(lastPT!=='mouse') return;
    if(closePanels()) return;
    if(Date.now()-panelsClosedAt<400) return;
    toggle(); bumpUI();
  });
  tapEl.addEventListener('dblclick',function(){ if(lastPT==='mouse') toggleFs(); });
  tapEl.addEventListener('pointerup',function(e){
    if(e.pointerType==='mouse') return;
    if(closePanels()) return;
    if(Date.now()-panelsClosedAt<400) return;
    var now=Date.now(), z=zoneOf(e);
    if(S.phase==='ended' || S.phase==='boot'){ bumpUI(); return; }
    if(z!=='c' && chainZone===z && now-chainT<650){
      clearTimeout(tapTimer); lastTap=0; chainT=now; skip(z); return;
    }
    if(now-lastTap<300 && z===lastZone){
      clearTimeout(tapTimer); lastTap=0;
      if(z==='c') toggle(); else { skip(z); chainZone=z; chainT=now; }
      return;
    }
    lastTap=now; lastZone=z;
    clearTimeout(tapTimer);
    tapTimer=setTimeout(singleTap,300);
  });
  app.addEventListener('pointermove',function(e){ if(e.pointerType==='mouse') bumpUI(); });
  rig.addEventListener('focusin',function(){ bumpUI(); });
  controls.addEventListener('pointerdown',function(){ bumpUI(); });
  // tira o foco dos botões depois do clique (o espaço volta a dar play/pause)
  rig.addEventListener('click',function(e){
    var b=e.target.closest ? e.target.closest('button') : null;
    if(b && e.detail>0 && b.closest('.controls,.mid,.top')) { if(b!==btnSet && b!==btnInfo && b!==btnScenes && b!==btnModes) b.blur(); }
  });
  $('mPlay').addEventListener('click',toggle);
  $('btnPlay').addEventListener('click',toggle);
  $('mBack').addEventListener('click',function(){ skip('l'); });
  $('mFwd').addEventListener('click',function(){ skip('r'); });
  $('mBack5').addEventListener('click',function(){ skip('l',5); });
  $('btnBack').addEventListener('click',function(){ skip('l'); });
  $('btnFwd').addEventListener('click',function(){ skip('r'); });

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
    if(!modes.night) lsSet(KVOL,JSON.stringify({v:video.volume,m:video.muted}));
  });
  (function(){
    var o=jget(KVOL,null);
    if(o){ if(typeof o.v==='number') video.volume=Math.max(0,Math.min(1,o.v)); video.muted=!!o.m; }
    applyVolUI();
  })();

  // ---------- enquadramento inteligente (sem deformar) ----------
  var fitInfo={rc:1};
  function zoomFor(f,rc){ return f==='cover'?rc:(f==='pano'?Math.min(rc,1.3):1); }
  function cropFor(z){
    var vw=video.videoWidth, vh=video.videoHeight, cw=rig.clientWidth, ch=rig.clientHeight;
    if(!vw||!vh||!cw||!ch) return 0;
    var c=Math.min(cw/vw,ch/vh);
    return 1-Math.min(1,cw/(vw*c*z))*Math.min(1,ch/(vh*c*z));
  }
  function applyFit(){
    var vw=video.videoWidth, vh=video.videoHeight, cw=rig.clientWidth, ch=rig.clientHeight;
    var rc=1;
    if(vw&&vh&&cw&&ch){ rc=Math.max(cw/vw,ch/vh)/Math.min(cw/vw,ch/vh); }
    fitInfo.rc=rc;
    var z=zoomFor(fit,rc);
    video.style.transform = z>1.002 ? 'scale('+z.toFixed(4)+')' : '';
    if(S.menu) buildMenu();
  }
  function setFit(f,quiet){
    fit=f; lsSet('pf:fit',f); applyFit(); renderModes();
    if(!quiet){
      var z=zoomFor(f,fitInfo.rc), c=Math.round(cropFor(z)*100);
      toast(f==='contain'?'Enquadramento: ajustar à tela':(c>0?'Enquadramento: pode cortar ~'+c+'% da imagem':'Enquadramento: sem cortes neste vídeo'));
    }
  }

  // ---------- configurações (velocidade, enquadramento, dados anônimos) ----------
  function rateLabel(s){ return s===1?'Normal':String(s).replace('.',',')+'x'; }
  function setRate(s){ video.playbackRate=s; toast('Velocidade: '+rateLabel(s)); if(S.menu) buildMenu(); }
  function fitLabel(f){
    var z=zoomFor(f,fitInfo.rc), c=Math.round(cropFor(z)*100);
    if(f==='contain') return ['Ajustar à tela','sem cortes'];
    var nm=f==='pano'?'Panorâmica':'Preencher';
    return [nm, c>0 ? 'pode cortar ~'+c+'% da imagem' : 'sem cortes neste vídeo'];
  }
  function buildMenu(){
    var keepFocus=document.activeElement && menu.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;
    while(menu.firstChild) menu.removeChild(menu.firstChild);
    var h=el('h3',null,'Velocidade'); menu.appendChild(h);
    var chips=el('div','chips'); chips.setAttribute('role','group');
    SPEEDS.forEach(function(s){
      var b=el('button','chip',rateLabel(s)); b.type='button';
      b.setAttribute('role','menuitemradio'); b.setAttribute('aria-checked',(video.playbackRate||1)===s?'true':'false'); b.setAttribute('data-k','r'+s);
      b.addEventListener('click',function(){ setRate(s); });
      chips.appendChild(b);
    });
    menu.appendChild(chips);
    menu.appendChild(el('h3',null,'Enquadramento'));
    ['contain','pano','cover'].forEach(function(f){
      var l=fitLabel(f);
      var b=el('button','mi'); b.type='button';
      b.setAttribute('role','menuitemradio'); b.setAttribute('aria-checked',fit===f?'true':'false'); b.setAttribute('data-k','f'+f);
      var t=el('span'); t.appendChild(document.createTextNode(l[0])); var sm=el('small',null,l[1]); t.appendChild(sm);
      b.appendChild(t); b.appendChild(svgUse('check'));
      b.addEventListener('click',function(){ setFit(f); });
      menu.appendChild(b);
    });
    if(C.tele){
      menu.appendChild(el('h3',null,'Privacidade'));
      var tb=el('button','mi'); tb.type='button'; tb.setAttribute('role','menuitemcheckbox'); tb.setAttribute('aria-checked',S.tele?'true':'false'); tb.setAttribute('data-k','tele');
      var tt=el('span'); tt.appendChild(document.createTextNode('Dados técnicos anônimos')); tt.appendChild(el('small',null,'Só erros e tempo de carga. Nada pessoal.'));
      tb.appendChild(tt); tb.appendChild(el('span','sw'));
      tb.addEventListener('click',function(){ S.tele=!S.tele; lsSet(KTELE,S.tele?'1':'0'); buildMenu(); toast(S.tele?'Obrigado por ajudar!':'Dados técnicos desligados'); });
      menu.appendChild(tb);
    }
    if(keepFocus) focusEl(menu.querySelector('[data-k="'+keepFocus+'"]'));
  }
  function setMenu(on){
    if(on===S.menu) return;
    if(on){ closePanel(true); buildMenu(); }
    S.menu=on; render();
    if(on){ setTimeout(function(){ focusEl(menu.querySelector('[aria-checked=true]')); },40); }
    else if(menu.contains(document.activeElement)) focusEl(btnSet);
    bumpUI();
  }
  btnSet.addEventListener('click',function(){ setMenu(!S.menu); });
  document.addEventListener('pointerdown',function(e){
    if(S.menu && !menu.contains(e.target) && !btnSet.contains(e.target)){ S.menu=false; panelsClosedAt=Date.now(); render(); }
  });

  // ---------- tela cheia + paisagem automática ----------
  function fsEl(){ return document.fullscreenElement||document.webkitFullscreenElement; }
  function toggleFs(){
    if(!guard('fs',450)) return;
    if(fsEl()){ (document.exitFullscreen||document.webkitExitFullscreen).call(document); return; }
    if(S.pfs){ S.pfs=false; updateRot(); return; }
    var fn=app.requestFullscreen||app.webkitRequestFullscreen;
    if(fn){
      var p;
      try{ p=fn.call(app,{navigationUI:'hide'}); }catch(e){ p=null; }
      if(p && p.then) p.then(function(){ lockLandscape(); },function(){ fallbackFs(); });
      else setTimeout(function(){ if(fsEl()) lockLandscape(); else fallbackFs(); },120);
    } else fallbackFs();
  }
  function fallbackFs(){
    if(video.webkitEnterFullscreen){ try{ video.webkitEnterFullscreen(); return; }catch(e){} }
    if(window.top===window && isTouch){ S.pfs=true; S.locked=false; updateRot(); toast('Gire o celular para assistir deitado'); return; }
    toast('Tela cheia indisponível aqui');
  }
  function lockLandscape(){
    if(!isTouch) return;
    if(video.videoWidth && video.videoWidth<video.videoHeight) return; // vídeo vertical: deixa em pé
    if(CAP.lock){
      S.lockPending=true;
      screen.orientation.lock('landscape').then(function(){ S.locked=true; S.lockPending=false; updateRot(); },
                                               function(){ S.locked=false; S.lockPending=false; updateRot(); });
    } else { S.locked=false; updateRot(); }
  }
  function unlockOrientation(){ try{ if(CAP.lock) screen.orientation.unlock(); }catch(e){} S.locked=false; S.lockPending=false; }
  // quando o aparelho não deixa travar em paisagem, gira a imagem 90° dentro da tela
  function updateRot(){
    var portrait=window.innerHeight>window.innerWidth;
    var want = isTouch && portrait && !S.lockPending && (((S.fs||S.pfs) && !S.locked) || S.manualRot);
    if(S.rot!==want) S.rot=want;
    render(); measure();
  }
  function onFs(){
    var on=!!fsEl();
    S.fs=on;
    btnFs.setAttribute('aria-label', on?'Sair da tela cheia':'Tela cheia');
    if(!on){
      unlockOrientation(); S.manualRot=false; S.pfs=false; S.soft=true;
      setTimeout(function(){ S.soft=false; render(); },1300);
      updateRot();
    } else { updateRot(); } // a recusa do travamento pode chegar antes deste evento: reavalia a rotação
    bumpUI(); setTimeout(measure,150);
  }
  btnFs.addEventListener('click',toggleFs);
  document.addEventListener('fullscreenchange',onFs);
  document.addEventListener('webkitfullscreenchange',onFs);
  video.addEventListener('webkitendfullscreen',function(){ bumpUI(); });

  // ---------- Picture-in-Picture e transmissão ----------
  function togglePip(){
    if(!guard('pip',600)) return;
    try{
      if(document.pictureInPictureElement){ document.exitPictureInPicture(); }
      else if(video.requestPictureInPicture){ video.requestPictureInPicture().catch(function(){ toast('Picture-in-Picture indisponível'); }); }
      else if(video.webkitSetPresentationMode){ video.webkitSetPresentationMode(video.webkitPresentationMode==='picture-in-picture'?'inline':'picture-in-picture'); }
    }catch(e){ toast('Picture-in-Picture indisponível'); }
  }
  btnPip.addEventListener('click',togglePip);
  video.addEventListener('enterpictureinpicture',function(){ S.pip=true; render(); });
  video.addEventListener('leavepictureinpicture',function(){ S.pip=false; render(); });
  video.addEventListener('webkitpresentationmodechanged',function(){ S.pip=(video.webkitPresentationMode==='picture-in-picture'); render(); });

  btnCast.hidden=true;
  function watchCast(){
    if(castWatching) return; castWatching=true;
    try{
      if(video.remote && video.remote.watchAvailability){
        video.remote.watchAvailability(function(av){ btnCast.hidden=!av; }).catch(function(){});
      }
    }catch(e){}
  }
  video.addEventListener('webkitplaybacktargetavailabilitychanged',function(e){ btnCast.hidden=(e.availability!=='available'); });
  btnCast.addEventListener('click',function(){
    if(!guard('cast',800)) return;
    try{
      if(video.webkitShowPlaybackTargetPicker && window.WebKitPlaybackTargetAvailabilityEvent) video.webkitShowPlaybackTargetPicker();
      else if(video.remote && video.remote.prompt){
        video.remote.prompt().catch(function(err){ toast(err && err.name==='NotFoundError' ? 'Nenhum dispositivo encontrado' : 'Transmissão indisponível para este vídeo'); });
      }
    }catch(e){ toast('Transmissão indisponível para este vídeo'); }
  });

  // ---------- legendas (tecla C / modo leitura) ----------
  function captions(on){
    var i, found=false, tt=video.textTracks;
    if(hls && hls.subtitleTracks && hls.subtitleTracks.length){
      if(on===undefined) on=hls.subtitleTrack<0;
      hls.subtitleTrack=on?0:-1; hls.subtitleDisplay=on; return true;
    }
    for(i=0;i<tt.length;i++){
      if(tt[i].kind==='subtitles'||tt[i].kind==='captions'){
        if(!found){ if(on===undefined) on=(tt[i].mode!=='showing'); found=true; }
        tt[i].mode=on?'showing':'disabled';
      }
    }
    return found ? on : null;
  }
  function toggleCaptions(){
    var r=captions();
    toast(r===null?'Legendas indisponíveis neste vídeo':(r?'Legendas ativadas':'Legendas desativadas'));
  }

  // ---------- painéis laterais: cenas, ficha, modos ----------
  var PANELS={scenes:['Mapa das cenas',btnScenes],info:['Ficha do filme',btnInfo],modes:['Modos de exibição',btnModes]};
  var panelOpener=null;
  function openPanel(name){
    if(S.panel===name){ closePanel(); return; }
    if(name==='scenes' && !buildScenes()){ toast('Aguarde o filme carregar'); return; }
    S.menu=false; panelOpener=PANELS[name][1];
    S.panel=name; dTitle.textContent=PANELS[name][0];
    if(name==='scenes'){ sceneIdx=-1; markScene(); startThumbs(); }
    if(name==='info'){ renderInfo(); loadFicha(); }
    if(name==='modes') renderModes();
    clearTimeout(napT); S.napReady=false;
    render(); bumpUI();
    setTimeout(function(){
      if(name==='scenes' && thumbs[sceneIdx]) centerInPanel(thumbs[sceneIdx].el);
      focusEl($('dClose'));
    },80);
  }
  function centerInPanel(node){
    if(S.rot) return;
    var db=drawer.querySelector('.dbody'), r=node.getBoundingClientRect(), br=db.getBoundingClientRect();
    db.scrollTop += (r.top-br.top)-(br.height-r.height)/2;
  }
  function closePanel(silent){
    if(!S.panel) return;
    var wasFocus = drawer.contains(document.activeElement);
    S.panel='';
    if(video.paused && S.started) armNap();
    if(!silent){ render(); bumpUI(); }
    if(wasFocus && panelOpener) focusEl(panelOpener);
  }
  btnScenes.addEventListener('click',function(){ openPanel('scenes'); });
  btnInfo.addEventListener('click',function(){ openPanel('info'); });
  btnModes.addEventListener('click',function(){ openPanel('modes'); });
  $('dClose').addEventListener('click',function(){ closePanel(); });

  // ---- mapa das cenas ----
  var thumbs=[], sceneIdx=-1, scBuilt=false, tj=null, SCENES=12;
  function buildScenes(){
    if(scBuilt) return true;
    var d=video.duration;
    if(!isFinite(d) || d<=0) return false;
    scBuilt=true;
    SCENES=Math.min(24,Math.max(8,Math.round(d/600)));
    $('scSub').textContent=SCENES+' cenas — toque para pular até lá.';
    var i;
    for(i=0;i<SCENES;i++){
      (function(i){
        var b=el('button','sc'); b.type='button';
        b.setAttribute('aria-label','Ir para '+fmt(d*i/SCENES));
        var c=document.createElement('canvas'); c.width=320; c.height=180;
        b.appendChild(c); b.appendChild(el('span','t',fmt(d*i/SCENES)));
        b.addEventListener('click',function(){ video.currentTime=d*i/SCENES; closePanel(); if(video.paused) tryPlay(); });
        scGrid.appendChild(b);
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
  // as miniaturas saem de um segundo <video> em baixa qualidade, só enquanto o painel está aberto
  function startThumbs(){
    if(tj){ if(!tj.finished) tj.step(); return; }
    if(navigator.connection && navigator.connection.saveData){ scGrid.classList.add('done'); return; }
    var d=video.duration, tv=document.createElement('video'), th=null, i=0, fails=0, busy=false;
    tj={finished:false, step:step};
    tv.muted=true; tv.preload='auto'; tv.setAttribute('playsinline','');
    function finish(){
      if(tj.finished) return;
      tj.finished=true; scGrid.classList.add('done');
      try{ if(th) th.destroy(); }catch(e){}
      try{ tv.removeAttribute('src'); tv.load(); }catch(e){}
    }
    function paint(k){
      try{
        var c=thumbs[k].c, x=c.getContext('2d'), vw=tv.videoWidth, vh=tv.videoHeight;
        if(!vw||!vh) return;
        var sc=Math.max(c.width/vw,c.height/vh), w=vw*sc, h=vh*sc;
        x.drawImage(tv,(c.width-w)/2,(c.height-h)/2,w,h);
        thumbs[k].el.classList.add('has');
      }catch(e){}
    }
    function after(){ if(fails>=4){ finish(); return; } step(); }
    function step(){
      if(tj.finished || busy || !S.panel || S.panel!=='scenes' || tv.readyState<1) return;
      if(i>=SCENES){ finish(); return; }
      busy=true;
      var idx=i, done=false, to;
      function on(){
        if(done) return;
        done=true; clearTimeout(to); tv.removeEventListener('seeked',on);
        paint(idx); i++; busy=false; setTimeout(after,80);
      }
      to=setTimeout(function(){
        if(done) return;
        done=true; tv.removeEventListener('seeked',on); fails++; i++; busy=false; after();
      },9000);
      tv.addEventListener('seeked',on);
      try{ tv.currentTime=Math.max(0,Math.min(d-1,d*idx/SCENES+6)); }
      catch(e){ done=true; clearTimeout(to); tv.removeEventListener('seeked',on); fails++; i++; busy=false; after(); }
    }
    tv.addEventListener('loadedmetadata',function(){ step(); });
    tv.addEventListener('error',finish);
    setTimeout(function(){ if(tv.readyState<1) finish(); },20000);
    var eng=pickEngine();
    if(eng==='hlsjs' && window.Hls){
      th=new Hls({enableWorker:false,startLevel:0,capLevelToPlayerSize:true,maxBufferLength:2,maxMaxBufferLength:4,backBufferLength:2});
      th.autoLevelCapping=0;
      th.on(Hls.Events.ERROR,function(_,e){ if(e && e.fatal) finish(); });
      th.loadSource(C.url); th.attachMedia(tv);
    } else if(eng==='native'){ tv.src=C.url; }
    else finish();
  }

  // ---- ficha do filme + recomendações (vêm da planilha, por /filme/ID?ficha=1) ----
  var FICHA={state:'idle',data:null}, fichaT=0;
  function loadFichaSoon(){ if(FICHA.state==='idle' && !fichaT) fichaT=setTimeout(loadFicha,1500); }
  function loadFicha(){
    if(FICHA.state!=='idle') return;
    FICHA.state='loading';
    var ctrl=window.AbortController?new AbortController():null, to=setTimeout(function(){ if(ctrl) ctrl.abort(); },12000);
    fetch(location.pathname+'?ficha=1&nome='+encodeURIComponent(C.title||''),{credentials:'omit',signal:ctrl?ctrl.signal:undefined})
      .then(function(r){ return r.json(); })
      .then(function(j){ clearTimeout(to); FICHA.data=(j&&j.ok)?j:null; FICHA.state=(j&&j.ok)?'ok':'fail'; afterFicha(); })
      .catch(function(){ clearTimeout(to); FICHA.state='fail'; afterFicha(); });
  }
  function afterFicha(){
    computeNext();
    if(S.panel==='info') renderInfo();
    if(S.phase==='ended') renderNext();
    if(preloaded) preloadRecs();
  }
  function metaNow(){
    var d=FICHA.data, m=d&&d.meta;
    return m || {nome:C.title,sinopse:C.desc,capa:C.poster,categorias:[],elenco:[]};
  }
  function renderInfo(){
    var body=$('infoBody'), m=metaNow(), d=FICHA.data;
    while(body.firstChild) body.removeChild(body.firstChild);
    var head=el('div','fhead'), post=el('div','fpost'); bg(post,m.capa||C.poster); head.appendChild(post);
    var side=el('div'); side.style.minWidth='0';
    side.appendChild(el('div','ftit',m.nome||C.title));
    var tags=el('div','tags');
    if(m.classificacao) tags.appendChild(el('span','tag age',m.classificacao));
    [m.ano,m.duracao,m.audio,m.plataforma].forEach(function(t){ if(t) tags.appendChild(el('span','tag',t)); });
    (m.categorias||[]).forEach(function(t){ tags.appendChild(el('span','tag',t)); });
    side.appendChild(tags); head.appendChild(side); body.appendChild(head);
    if(FICHA.state==='loading' || FICHA.state==='idle'){
      body.appendChild(el('div','sk')); body.appendChild(el('div','sk')); body.appendChild(el('div','sk'));
    }
    var syn=m.sinopse||C.desc;
    if(syn){ body.appendChild(el('div','fh3','Sinopse')); body.appendChild(el('p','fsyn',syn)); }
    else if(FICHA.state==='ok' || FICHA.state==='fail') body.appendChild(el('p','sub','Sem sinopse disponível por enquanto.'));
    var dur=video.duration;
    if(dur>0 && isFinite(dur)){
      var left=Math.max(0,dur-(video.currentTime||0))/(video.playbackRate||1);
      var fe=el('div','fend'); fe.appendChild(el('b',null,'Termina às '+hhmm(new Date(Date.now()+left*1000))));
      fe.appendChild(document.createTextNode(' se você continuar agora · faltam '+fmt(left)));
      body.appendChild(fe);
    }
    if(m.elenco && m.elenco.length){
      body.appendChild(el('div','fh3','Elenco'));
      var cast=el('div','cast');
      m.elenco.forEach(function(p){
        var ci=el('div','ci'), i=el('i',null,(p.n||'?').charAt(0).toUpperCase());
        if(safeUrl(p.f)){ i.textContent=''; bg(i,p.f); }
        ci.appendChild(i); ci.appendChild(el('span',null,p.n)); cast.appendChild(ci);
      });
      body.appendChild(cast);
    }
    if(safeUrl(m.trailer)){
      var a=el('a','lnk','▶ Ver trailer'); a.href=m.trailer; a.target='_blank'; a.rel='noopener noreferrer'; body.appendChild(a);
    }
    if(FICHA.state==='fail') body.appendChild(el('p','sub','Não deu para carregar todos os detalhes agora.'));
    else if(d && !d.matched) body.appendChild(el('p','sub','Detalhes completos deste filme ainda não estão na planilha.'));
  }

  // ---- modos: cinema, madrugada, leitura, tela panorâmica ----
  var nightPrev=null;
  var MODEDEF=[
    ['cinema','film','Cinema','Só o filme: some o título, o relógio e os degradês, e os controles escondem rápido.'],
    ['night','moon','Madrugada','Tom quente, brilho mais baixo e volume limitado a 35% para não acordar ninguém.'],
    ['read','book','Leitura','Legendas grandes e com fundo forte, controles maiores e botão extra de voltar 5 s para reler uma fala.'],
    ['pano','wide','Tela panorâmica','Aproveita telas largas ampliando a imagem até 30%, sem deformar. Mostra quanto pode cortar.']
  ];
  function saveModes(){ lsSet(KMODES,JSON.stringify({cinema:modes.cinema,night:modes.night,read:modes.read})); }
  function anyMode(){ return modes.cinema||modes.night||modes.read||fit==='pano'; }
  function setMode(k,on,quiet){
    if(k==='pano'){ setFit(on?'pano':'contain',true); if(!quiet){ var c=Math.round(cropFor(zoomFor('pano',fitInfo.rc))*100); toast(on?(c>0?'Tela panorâmica: pode cortar ~'+c+'% da imagem':'Tela panorâmica ativa'):'Tela panorâmica desligada'); } return; }
    modes[k]=on;
    if(k==='night'){
      if(on){ nightPrev=video.volume; if(!video.muted && video.volume>0.35) video.volume=0.35; }
      else if(nightPrev!=null){ if(Math.abs(video.volume-0.35)<0.011) video.volume=nightPrev; nightPrev=null; }
    }
    if(k==='read' && on) captions(true);
    if(k==='cinema') postParent({type:'pipocaflix:cinema',on:on});
    saveModes(); render(); renderModes(); bumpUI();
    if(!quiet) toast((on?'Modo ':'Saiu do modo ')+MODEDEF.filter(function(m){return m[0]===k;})[0][2]);
  }
  function resetModes(){
    ['cinema','night','read'].forEach(function(k){ if(modes[k]) setMode(k,false,true); });
    setFit('contain',true); S.manualRot=false; updateRot(); renderModes(); toast('Tudo normal');
  }
  function renderModes(){
    btnModes.classList.toggle('has-dot',anyMode());
    if(S.panel!=='modes') return;
    var body=$('modesBody'); while(body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(el('p','sub','Escolha como quer assistir. Dá para combinar os modos.'));
    MODEDEF.forEach(function(m){
      var on = m[0]==='pano' ? fit==='pano' : modes[m[0]];
      var b=el('button','mode'); b.type='button'; b.setAttribute('aria-pressed',on?'true':'false'); b.setAttribute('data-mode',m[0]);
      b.appendChild(svgUse(m[1]));
      var t=el('div','mt'); t.appendChild(el('b',null,m[2])); t.appendChild(el('span','d',m[3])); b.appendChild(t);
      b.appendChild(el('span','sw'));
      b.addEventListener('click',function(){ setMode(m[0],!on); });
      body.appendChild(b);
    });
    if(isTouch && window.innerHeight>window.innerWidth && (window.top===window || S.fs)){
      var rb=el('button','mode'); rb.type='button'; rb.setAttribute('aria-pressed',S.manualRot?'true':'false');
      rb.appendChild(svgUse('rotate'));
      var rt=el('div','mt'); rt.appendChild(el('b',null,'Girar a tela')); rt.appendChild(el('span','d','Para quando o celular está com a rotação travada: deita a imagem. Toque de novo para inverter o lado.')); rb.appendChild(rt); rb.appendChild(el('span','sw'));
      rb.addEventListener('click',function(){
        if(!S.manualRot){ S.manualRot=true; S.flip=false; }
        else if(!S.flip){ S.flip=true; }
        else { S.manualRot=false; S.flip=false; }
        updateRot(); renderModes();
      });
      body.appendChild(rb);
    }
    var row=el('div','cta'); row.style.margin='14px 0 4px';
    var rs=el('button','gbtn','Voltar ao normal'); rs.type='button'; rs.addEventListener('click',resetModes); row.appendChild(rs);
    body.appendChild(row);
    if(isTouch){ return; }
    body.appendChild(el('div','fh3','Atalhos do teclado'));
    var keys=el('div','keys');
    [['Espaço','play/pause'],['J / L','−10 s / +10 s'],['↑ ↓','volume'],['0–9','pular para 0–90%'],['F','tela cheia'],['M','mudo'],['C','legendas'],['T','modo cinema'],['I','ficha'],['S','cenas'],['O','modos'],['P','picture-in-picture']].forEach(function(k){
      var line=el('div'); var kb=el('kbd',null,k[0]); line.appendChild(kb); line.appendChild(document.createTextNode(' '+k[1])); keys.appendChild(line);
    });
    body.appendChild(keys);
  }
  (function restoreModes(){
    var o=jget(KMODES,null), f=lsGet('pf:fit');
    if(o){
      ['cinema','night','read'].forEach(function(k){ if(o[k]) { modes[k]=true; if(k==='night' && !video.muted && video.volume>0.35){ nightPrev=video.volume; video.volume=0.35; } } });
      if(modes.cinema) postParent({type:'pipocaflix:cinema',on:true});
    }
    if(f==='pano'||f==='cover') fit=f;
    renderModes();
  })();

  // ---- próximo filme inteligente + salvar ----
  var NEXT=null;
  function readSaved(){ return jget(KSAVED,[]); }
  function isSaved(n){ var k=norm(n); return readSaved().some(function(s){ return norm(s.n)===k; }); }
  function markWatched(){
    if(watchedMarked) return; watchedMarked=true;
    var m=metaNow(), h=jget(KHIST,[]);
    var key=norm(m.nome||C.title);
    h=h.filter(function(x){ return norm(x.n)!==key; });
    h.push({n:m.nome||C.title,g:(m.categorias||[]).slice(0,4),t:Date.now()});
    lsSet(KHIST,JSON.stringify(h.slice(-60)));
  }
  function computeNext(){
    var d=FICHA.data;
    if(!d || !d.recs || !d.recs.length){ NEXT=null; return; }
    var hist=jget(KHIST,[]), done={}, gw={}, maxw=1, k;
    hist.forEach(function(h){ done[norm(h.n)]=1; (h.g||[]).forEach(function(g){ g=norm(g); gw[g]=(gw[g]||0)+1; }); });
    readSaved().forEach(function(s){ (s.g||[]).forEach(function(g){ g=norm(g); gw[g]=(gw[g]||0)+0.6; }); });
    for(k in gw) if(gw[k]>maxw) maxw=gw[k];
    var curG={}, me=d.meta, curName=norm((me&&me.nome)||C.title);
    if(me) (me.categorias||[]).forEach(function(g){ curG[norm(g)]=1; });
    var list=d.recs.filter(function(r){ return norm(r.nome)!==curName; }).map(function(r){
      var s=r.sc||0, best=0, bestG='', shared='';
      (r.categorias||[]).forEach(function(g){
        var w=(gw[norm(g)]||0)/maxw; s+=w*2.2;
        if(w>best){ best=w; bestG=g; }
        if(curG[norm(g)] && !shared) shared=g;
      });
      if(done[norm(r.nome)]) s-=10;
      var why = shared ? 'Parecido com o que você está vendo' : (best>0.34 ? 'Combina com seu gosto por '+bestG : 'Do nosso catálogo para você');
      return {r:r,s:s,why:why};
    });
    list.sort(function(a,b){ return b.s-a.s; });
    NEXT={items:list.slice(0,5),idx:0};
  }
  function watchHref(r){
    if(r.tmdb) return {href:'/filme/'+r.tmdb,target:'_self'};
    return {href:(C.site||'')+'/filme.html?nome='+encodeURIComponent(r.nome),target:'_top'};
  }
  function toggleSave(r){
    var list=readSaved(), key=norm(r.nome), had=list.some(function(s){ return norm(s.n)===key; });
    list=list.filter(function(s){ return norm(s.n)!==key; });
    if(!had) list.push({n:r.nome,g:(r.categorias||[]).slice(0,4),t:Date.now()});
    lsSet(KSAVED,JSON.stringify(list.slice(-80)));
    postParent({type:'pipocaflix:save',saved:!had,item:{nome:r.nome,capa:r.capa,ano:r.ano,categoria:(r.categorias||[]).join(', '),tmdb:r.tmdb||'',tipo:'filme'}});
    toast(!had?'Salvo na sua lista':'Removido da sua lista');
    return !had;
  }
  function renderNext(){
    var card=$('nextCard'); while(card.firstChild) card.removeChild(card.firstChild);
    var hd=el('div','nxh'); var cap=el('span',null,NEXT?'Próximo filme para você':'Fim'); hd.appendChild(cap);
    var x=el('button','btn'); x.type='button'; x.setAttribute('aria-label','Fechar'); x.appendChild(svgUse('close'));
    x.addEventListener('click',function(){ S.nextClosed=true; render(); setTimeout(function(){ focusEl($('mPlay')); },60); });
    hd.appendChild(x); card.appendChild(hd);
    var replay=el('button','gbtn'); replay.type='button'; replay.appendChild(svgUse('replay')); replay.appendChild(document.createTextNode('Rever'));
    replay.addEventListener('click',function(){ S.nextClosed=true; video.currentTime=0; tryPlay(); });
    if(!NEXT || !NEXT.items.length){
      card.appendChild(el('h2',null,'Gostou do filme?'));
      card.appendChild(el('p',null,'Veja mais títulos no catálogo ou reveja do começo.'));
      var cta=el('div','cta'); cta.appendChild(replay);
      var more=el('a','pbtn','Ver catálogo'); more.href=(C.site||'/'); more.target='_top'; cta.appendChild(more);
      card.appendChild(cta); return;
    }
    var it=NEXT.items[NEXT.idx], r=it.r;
    var nx=el('div','nx'), p=el('div','nxp'); bg(p,r.capa); nx.appendChild(p);
    var t=el('div','nxt'); t.appendChild(el('span','why',it.why)); t.appendChild(el('h2',null,r.nome));
    t.appendChild(el('div','meta',[r.ano,r.duracao,(r.categorias||[]).slice(0,2).join(' · ')].filter(Boolean).join(' · ')));
    if(r.sinopse) t.appendChild(el('p','syn',r.sinopse));
    var act=el('div','nxa'); var w=watchHref(r);
    var a=el('a','pbtn'); a.href=w.href; a.target=w.target; a.rel='noopener'; a.appendChild(svgUse('play')); a.appendChild(document.createTextNode('Assistir'));
    act.appendChild(a);
    var sv=el('button','gbtn'); sv.type='button';
    function paintSave(){ while(sv.firstChild) sv.removeChild(sv.firstChild); var on=isSaved(r.nome); sv.appendChild(svgUse(on?'marked':'mark')); sv.appendChild(document.createTextNode(on?'Salvo':'Salvar')); }
    paintSave(); sv.addEventListener('click',function(){ toggleSave(r); paintSave(); });
    act.appendChild(sv); act.appendChild(replay);
    t.appendChild(act); nx.appendChild(t); card.appendChild(nx);
    if(NEXT.items.length>1){
      var row=el('div','nxl');
      NEXT.items.forEach(function(o,i){
        var b=el('button','alt'+(i===NEXT.idx?' on':'')); b.type='button'; b.setAttribute('aria-label','Ver '+o.r.nome); bg(b,o.r.capa);
        b.addEventListener('click',function(){ NEXT.idx=i; renderNext(); });
        row.appendChild(b);
      });
      card.appendChild(row);
    }
  }
  // pré-carrega só os pôsteres (metadados leves) das sugestões, nunca o filme
  function preloadRecs(){
    if(!FICHA.data||!FICHA.data.recs) return;
    FICHA.data.recs.slice(0,6).forEach(function(r){ var u=safeUrl(r.capa); if(u){ var im=new Image(); im.referrerPolicy='no-referrer'; im.src=u; } });
  }

  // ---------- Media Session, tela sempre ligada ----------
  var wl=null;
  function wakeOn(){
    if(!CAP.wake || wl) return;
    try{ navigator.wakeLock.request('screen').then(function(l){ wl=l; l.addEventListener('release',function(){ wl=null; }); }).catch(function(){}); }catch(e){}
  }
  function wakeOff(){ if(wl){ try{ wl.release(); }catch(e){} wl=null; } }
  if(CAP.media){
    try{
      navigator.mediaSession.metadata=new MediaMetadata({title:C.title||'Filme',artist:'PipocaFlix',artwork:C.poster?[{src:C.poster,sizes:'500x750'}]:[]});
      navigator.mediaSession.setActionHandler('play',function(){ tryPlay(); });
      navigator.mediaSession.setActionHandler('pause',function(){ video.pause(); });
      navigator.mediaSession.setActionHandler('seekbackward',function(){ seekBy(-10); });
      navigator.mediaSession.setActionHandler('seekforward',function(){ seekBy(10); });
      navigator.mediaSession.setActionHandler('seekto',function(d){ if(d && isFinite(d.seekTime)) video.currentTime=d.seekTime; });
    }catch(e){}
  }

  // ---------- teclado ----------
  document.addEventListener('keydown',function(e){
    if(e.ctrlKey||e.metaKey||e.altKey) return;
    var k=e.key, tag=e.target && e.target.tagName;
    if(k==='Escape'){ if(closePanels()){ e.preventDefault(); } return; }
    if(S.phase==='resume'||S.phase==='error') return;
    if(tag==='INPUT' && (k==='ArrowUp'||k==='ArrowDown'||k==='ArrowLeft'||k==='ArrowRight'||k==='Home'||k==='End')) return;
    if((tag==='BUTTON'||tag==='A') && (k===' '||k==='Enter')) return;
    if(S.menu && (k==='ArrowUp'||k==='ArrowDown')){
      var items=Array.prototype.slice.call(menu.querySelectorAll('button')), i=items.indexOf(document.activeElement);
      i=(i+(k==='ArrowDown'?1:-1)+items.length)%items.length; focusEl(items[i]); e.preventDefault(); return;
    }
    var handled=true;
    if(k===' '||k==='k'||k==='K') toggle();
    else if(k==='ArrowLeft') skip('l',modes.read?5:10);
    else if(k==='ArrowRight') skip('r',modes.read?5:10);
    else if(k==='j'||k==='J') skip('l');
    else if(k==='l'||k==='L') skip('r');
    else if(k==='ArrowUp') setVol(video.volume+0.1,true);
    else if(k==='ArrowDown') setVol(video.volume-0.1,true);
    else if(/^[0-9]$/.test(k)){ if(isFinite(video.duration)) video.currentTime=video.duration*(+k)/10; }
    else if(k==='f'||k==='F') toggleFs();
    else if(k==='m'||k==='M') toggleMute();
    else if(k==='c'||k==='C') toggleCaptions();
    else if(k==='t'||k==='T') setMode('cinema',!modes.cinema);
    else if(k==='i'||k==='I') openPanel('info');
    else if(k==='s'||k==='S') openPanel('scenes');
    else if(k==='o'||k==='O') openPanel('modes');
    else if((k==='p'||k==='P') && CAP.pip) togglePip();
    else if(k==='>'||k==='.'){ var ni=SPEEDS.indexOf(video.playbackRate||1); setRate(SPEEDS[Math.min(SPEEDS.length-1,ni+1)]); }
    else if(k==='<'||k===','){ var pi=SPEEDS.indexOf(video.playbackRate||1); setRate(SPEEDS[Math.max(0,pi-1)]); }
    else handled=false;
    if(handled){ e.preventDefault(); bumpUI(); }
  });

  // ---------- início ----------
  mDraw(0);
  if(C.backdrop||C.poster){ bg($('backdrop'),C.backdrop||C.poster); }
  measure();
  applyFit();
  var raw=parseInt(lsGet(KPOS),10);
  savedPos=(isFinite(raw) && raw>=30)?raw:0;
  if(savedPos>0){
    S.phase='resume'; S.buffering=false;
    $('resTime').textContent=fmt(savedPos);
    render();
    setTimeout(function(){ focusEl($('btnResume')); },80);
    $('btnResume').addEventListener('click',function(){ startSource(savedPos,true); });
    $('btnRestart').addEventListener('click',function(){ lsDel(KPOS); startSource(0,true); });
  } else {
    startSource(0,true);
  }
  bumpUI();
})();
`;
