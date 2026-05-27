'use strict';

// ─── DEPS ─────────────────────────────────────────────────────────────────────
const express    = require('express');
const multer     = require('multer');
const { createCanvas, registerFont, ImageData } = require('canvas');
const { execSync, spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const os         = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── DIRS ─────────────────────────────────────────────────────────────────────
const TMP   = path.join(os.tmpdir(), 'subtitler');
const FONTS = path.join(__dirname, 'fonts');
fs.mkdirSync(TMP,   { recursive: true });
fs.mkdirSync(FONTS, { recursive: true });

// ─── DOWNLOAD HELPER ──────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) { resolve(); return; }
    console.log(`Descargando fuente: ${path.basename(dest)}`);
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} al descargar ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ─── FONT URLS (Google Fonts CDN — archivos .ttf estables) ───────────────────
// Montserrat Bold  →  reemplaza DM Sans 700
// Playfair Display Italic 400 + SemiBold Italic 600  →  reemplaza Cormorant Garamond
const FONT_FILES = [
  {
    url:  'https://fonts.gstatic.com/s/montserrat/v26/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCtr6Hw5aXo.woff2',
    file: 'Montserrat-Bold.ttf',
    family: 'Montserrat',
    weight: '700',
    style:  'normal',
  },
  {
    url:  'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKdFvUDQ.woff2',
    file: 'PlayfairDisplay-Italic.ttf',
    family: 'Playfair Display',
    weight: '400',
    style:  'italic',
  },
  {
    url:  'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKd3vUDQ.woff2',
    file: 'PlayfairDisplay-SemiBoldItalic.ttf',
    family: 'Playfair Display',
    weight: '600',
    style:  'italic',
  },
];

// ─── FONT FALLBACKS (URLs alternativas con formato .ttf directo) ──────────────
const FONT_FALLBACKS = [
  {
    url:  'https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat-Bold.ttf',
    file: 'Montserrat-Bold.ttf',
    family: 'Montserrat',
    weight: '700',
    style:  'normal',
  },
  {
    url:  'https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay-Italic.ttf',
    file: 'PlayfairDisplay-Italic.ttf',
    family: 'Playfair Display',
    weight: '400',
    style:  'italic',
  },
  {
    url:  'https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay-SemiBoldItalic.ttf',
    file: 'PlayfairDisplay-SemiBoldItalic.ttf',
    family: 'Playfair Display',
    weight: '600',
    style:  'italic',
  },
];

// ─── LOAD FONTS ───────────────────────────────────────────────────────────────
let fontsReady = false;

async function loadFonts() {
  for (let i = 0; i < FONT_FILES.length; i++) {
    const f    = FONT_FILES[i];
    const dest = path.join(FONTS, f.file);

    // Intentar primero URL principal, luego fallback
    try {
      await downloadFile(f.url, dest);
    } catch (e) {
      console.warn(`URL principal falló para ${f.file}: ${e.message}. Intentando fallback…`);
      try {
        await downloadFile(FONT_FALLBACKS[i].url, dest);
      } catch (e2) {
        console.error(`Fallback también falló para ${f.file}: ${e2.message}`);
        continue;
      }
    }

    try {
      registerFont(dest, { family: f.family, weight: f.weight, style: f.style });
      console.log(`✓ Fuente registrada: ${f.family} ${f.weight} ${f.style}`);
    } catch (e) {
      console.error(`Error registrando fuente ${f.file}: ${e.message}`);
    }
  }
  fontsReady = true;
  console.log('✓ Fuentes listas');
}

// ─── MULTER ───────────────────────────────────────────────────────────────────
const upload = multer({
  dest: TMP,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

app.get('/', (_req, res) => res.json({ status: 'ok', fonts: fontsReady }));

// ─── EASING ──────────────────────────────────────────────────────────────────
function easeOutCubic(t) {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 3);
}

// ─── WORD STATE HELPERS ───────────────────────────────────────────────────────
// Replica exacta de getWordState / wordPos del frontend
function makeWordState() { return { baseX: null, baseY: null, dx: 0, dy: 0, scale: 1.0 }; }

function getWordState(wordState, bi, wi) {
  if (!wordState[bi]) wordState[bi] = {};
  if (!wordState[bi][wi]) wordState[bi][wi] = makeWordState();
  return wordState[bi][wi];
}

function wordPos(wordState, bi, wi) {
  const ws = getWordState(wordState, bi, wi);
  return { x: (ws.baseX || 0) + ws.dx, y: (ws.baseY || 0) + ws.dy, scale: ws.scale };
}

// ─── INIT WORD BASES — replica exacta del frontend ───────────────────────────
function initWordBases(ctx, wordState, bi, blocks, W, H) {
  const b = blocks[bi];
  if (!b) return;

  if (b.type === 'B') {
    const allWords = b.words;
    const mid      = Math.ceil(allWords.length / 2);
    const szBold   = H * 0.038;
    const lineH    = szBold * 1.3;
    const baseCX   = W * 0.5;
    const baseCY   = H * 0.5;

    allWords.forEach((word, wi) => {
      const ws = getWordState(wordState, bi, wi);
      if (ws.baseX !== null) return;
      const lineIdx    = wi < mid ? 0 : 1;
      const wordsInLine = lineIdx === 0 ? allWords.slice(0, mid) : allWords.slice(mid);
      const idxInLine   = lineIdx === 0 ? wi : wi - mid;
      const lineWidths  = wordsInLine.map(w2 => {
        ctx.font = `700 ${szBold}px 'Montserrat', sans-serif`;
        return ctx.measureText(w2).width;
      });
      const totalLineW = lineWidths.reduce((a, v) => a + v, 0) + (wordsInLine.length - 1) * szBold * 0.3;
      const totalBH    = allWords.length > mid ? lineH * 2 : lineH;
      let xCursor = baseCX - totalLineW / 2;
      for (let k = 0; k < idxInLine; k++) xCursor += lineWidths[k] + szBold * 0.3;
      ws.baseX = xCursor + lineWidths[idxInLine] / 2;
      ws.baseY = baseCY - totalBH / 2 + szBold / 2 + lineIdx * lineH;
    });

  } else {
    // Type A
    const words = b.words;
    if (!words.length) return;
    let bigIdx = 0;
    for (let k = 1; k < words.length; k++) {
      if (words[k].length > words[bigIdx].length) bigIdx = k;
    }
    const szBig    = H * 0.095;
    const szTiny   = H * 0.052;
    const lineSmall = szTiny * 1.2;
    const totalH   = lineSmall + szBig + lineSmall * 1.6;
    const baseCX   = W * 0.5;
    const baseCY   = H * 0.5;
    const blockTop = baseCY - totalH / 2;
    const yBigBase = blockTop + lineSmall + szBig * 0.5;

    // Big word
    const rawBig  = words[bigIdx];
    const wordBig = rawBig.charAt(0).toUpperCase() + rawBig.slice(1).toLowerCase();
    ctx.font = `italic 600 ${szBig}px 'Playfair Display', serif`;
    const bigW  = ctx.measureText(wordBig).width;
    const wsBig = getWordState(wordState, bi, bigIdx);
    if (wsBig.baseX === null) { wsBig.baseX = baseCX; wsBig.baseY = yBigBase; }

    // Before words
    const beforeWords = words.slice(0, bigIdx);
    if (beforeWords.length) {
      const beforeWidths = beforeWords.map(w => {
        ctx.font = `italic 400 ${szTiny}px 'Playfair Display', serif`;
        return ctx.measureText(w).width;
      });
      const totalBeforeW = beforeWidths.reduce((a, v) => a + v, 0) + (beforeWords.length - 1) * szTiny * 0.2;
      let xCursor = (baseCX - bigW * 0.15) - totalBeforeW / 2;
      beforeWords.forEach((bw, k) => {
        const ws2 = getWordState(wordState, bi, k);
        if (ws2.baseX === null) {
          ws2.baseX = xCursor + beforeWidths[k] / 2;
          ws2.baseY = blockTop + lineSmall * 0.5;
        }
        xCursor += beforeWidths[k] + szTiny * 0.2;
      });
    }

    // After words
    const afterWords = words.slice(bigIdx + 1);
    if (afterWords.length) {
      const afterWidths = afterWords.map(w => {
        ctx.font = `italic 400 ${szTiny}px 'Playfair Display', serif`;
        return ctx.measureText(w).width;
      });
      const totalAfterW = afterWidths.reduce((a, v) => a + v, 0) + (afterWords.length - 1) * szTiny * 0.2;
      let xCursor = (baseCX + bigW * 0.15) - totalAfterW / 2;
      afterWords.forEach((word, k) => {
        const wi2 = bigIdx + 1 + k;
        const ws2 = getWordState(wordState, bi, wi2);
        if (ws2.baseX === null) {
          ws2.baseX = xCursor + afterWidths[k] / 2;
          ws2.baseY = blockTop + lineSmall + szBig + lineSmall * 0.8;
        }
        xCursor += afterWidths[k] + szTiny * 0.2;
      });
    }
  }
}

// ─── PAINT TEXT PARTICLE — replica exacta del frontend ───────────────────────
function paintTextParticle(ctx, text, cx, cy, font, size, alpha, glowAmt, exitP) {
  if (alpha <= 0 || !text) return;
  ctx.save();
  const scaleOut  = 1 + exitP * 0.06;
  const fadeAlpha = alpha * (exitP > 0 ? easeOutCubic(1 - exitP) : 1);
  if (fadeAlpha < 0.005) { ctx.restore(); return; }

  ctx.translate(cx, cy); ctx.scale(scaleOut, scaleOut); ctx.translate(-cx, -cy);
  ctx.globalAlpha  = Math.min(1, Math.max(0, fadeAlpha));
  ctx.font         = font;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  if (glowAmt > 0) {
    // Outer mega-glow
    ctx.shadowColor = 'rgba(255,255,255,1)';
    ctx.shadowBlur  = size * glowAmt * 4.5 * (1 - exitP * 0.5);
    ctx.fillStyle   = 'rgba(255,255,255,0.12)';
    ctx.fillText(text, cx, cy);
    // Mid glow
    ctx.shadowBlur  = size * glowAmt * 2.8;
    ctx.fillStyle   = 'rgba(255,255,255,0.28)';
    ctx.fillText(text, cx, cy);
    // Inner glow
    ctx.shadowBlur  = size * glowAmt * 1.2;
    ctx.fillStyle   = 'rgba(255,253,248,0.55)';
    ctx.fillText(text, cx, cy);
  }
  // Crisp final fill
  ctx.shadowColor = glowAmt > 0 ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.6)';
  ctx.shadowBlur  = glowAmt > 0 ? size * glowAmt * 0.7 * (1 - exitP * 0.5) : size * 0.22;
  ctx.fillStyle   = 'rgb(255,255,255)';
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

// ─── DRAW SUBTITLES — replica exacta del frontend (fuentes actualizadas) ─────
function drawSubtitles(ctx, W, H, t, blocks, wordState, bi) {
  const MARGIN   = Math.min(W, H) * 0.074;
  const FADE_IN  = 0.18;
  const FADE_OUT = 0.55;
  const STAGGER  = 0.18;

  function clampX(x, hw, ws) {
    if (!ws || (ws.dx === 0 && ws.dy === 0)) return x;
    return Math.max(MARGIN + hw, Math.min(W - MARGIN - hw, x));
  }
  function clampY(y, hh, ws) {
    if (!ws || (ws.dx === 0 && ws.dy === 0)) return y;
    return Math.max(MARGIN + hh, Math.min(H - MARGIN - hh, y));
  }

  const block = blocks[bi];
  if (!block) return;
  if (t < block.start - FADE_IN || t > block.end + FADE_OUT) return;

  // Ensure bases initialized
  initWordBases(ctx, wordState, bi, blocks, W, H);

  const rel    = t - block.start;
  let bAlpha   = 1;
  if (t < block.start) bAlpha = easeOutCubic((t - (block.start - FADE_IN)) / FADE_IN);
  else if (t > block.end) bAlpha = Math.max(0, 1 - (t - block.end) / FADE_OUT);

  const exitP      = t > block.end ? Math.min(1, (t - block.end) / FADE_OUT) : 0;
  const entryP     = Math.min(1, Math.max(0, rel / 0.55));
  const entryBounce = entryP < 1 ? 1 + Math.sin(entryP * Math.PI) * 0.13 * (1 - entryP) : 1;
  const breathScale = entryBounce;
  const floatY      = 0;

  const la      = (t0) => easeOutCubic((rel - t0) / FADE_IN) * bAlpha;
  const enterOff = (t0) => (1 - easeOutCubic(Math.max(0, rel - t0) / FADE_IN)) * H * 0.042;

  const resolvePos = (wi) => {
    const p = wordPos(wordState, bi, wi);
    return { x: p.x, y: p.y, scale: p.scale };
  };

  // ── BLOQUE B ────────────────────────────────────────────────────────────────
  if (block.type === 'B') {
    const allWords    = block.words;
    const szBold_base = H * 0.038;

    allWords.forEach((word, wi) => {
      const ws     = getWordState(wordState, bi, wi);
      const szBold = szBold_base * ws.scale * breathScale;
      const fBold  = `700 ${szBold}px 'Montserrat', sans-serif`;
      ctx.font     = fBold;
      const ww     = ctx.measureText(word).width;
      const pos    = resolvePos(wi);
      const rawX   = clampX(pos.x, ww / 2, ws);
      const rawY   = clampY(pos.y, szBold * 0.6, ws);
      const a      = la(0);
      const ey     = enterOff(0);
      paintTextParticle(ctx, word, rawX, rawY + ey + floatY, fBold, szBold, a, 0.45, exitP);
    });
    return;
  }

  // ── BLOQUE A ────────────────────────────────────────────────────────────────
  const words = block.words;
  if (!words.length) return;

  let bigIdx = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i].length > words[bigIdx].length) bigIdx = i;
  }

  const szTiny_base = H * 0.052;
  const szBig_base  = H * 0.095;

  // BIG word
  const wsBig  = getWordState(wordState, bi, bigIdx);
  const szBig  = szBig_base * wsBig.scale * breathScale;
  const fBig   = `italic 600 ${szBig}px 'Playfair Display', serif`;
  const rawBig = words[bigIdx];
  const wordBig = rawBig.charAt(0).toUpperCase() + rawBig.slice(1).toLowerCase();
  ctx.font     = fBig;
  const bigW   = ctx.measureText(wordBig).width;
  const posBig = resolvePos(bigIdx);
  const bigX   = clampX(posBig.x, bigW / 2, wsBig);
  const bigY   = clampY(posBig.y, szBig * 0.6, wsBig);
  const aBig   = la(STAGGER);
  const eyB    = enterOff(STAGGER);
  paintTextParticle(ctx, wordBig, bigX, bigY + eyB + floatY * 1.4, fBig, szBig, aBig, 0.95, exitP);

  // BEFORE words
  const beforeWords = words.slice(0, bigIdx);
  beforeWords.forEach((bw, k) => {
    const wi2  = k;
    const ws2  = getWordState(wordState, bi, wi2);
    const sz2  = szTiny_base * ws2.scale * breathScale;
    const fTiny = `italic 400 ${sz2}px 'Playfair Display', serif`;
    ctx.font   = fTiny;
    const ww   = ctx.measureText(bw).width;
    const pos2 = resolvePos(wi2);
    const cx2  = clampX(pos2.x, ww / 2, ws2);
    const cy2  = clampY(pos2.y, sz2 * 0.6, ws2);
    const aL   = la(0);
    const eyL  = enterOff(0);
    const fadeAlpha = aL * (exitP > 0 ? easeOutCubic(1 - exitP) : 1);
    const slideX    = (1 - easeOutCubic(Math.max(0, rel) / FADE_IN)) * -W * 0.072;
    ctx.save();
    if (exitP > 0) {
      ctx.translate(cx2, cy2 + eyL + floatY);
      ctx.scale(1 + exitP * 0.06, 1 + exitP * 0.06);
      ctx.translate(-cx2, -(cy2 + eyL + floatY));
    }
    ctx.font         = fTiny;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha  = Math.min(1, Math.max(0, fadeAlpha));
    ctx.shadowColor  = 'rgba(255,255,255,1)';
    ctx.shadowBlur   = sz2 * 0.55;
    ctx.fillStyle    = 'rgb(255,255,255)';
    ctx.fillText(bw, cx2 + slideX, cy2 + eyL + floatY);
    ctx.restore();
  });

  // AFTER words
  const afterWords = words.slice(bigIdx + 1);
  afterWords.forEach((word, k) => {
    const wi2   = bigIdx + 1 + k;
    const ws2   = getWordState(wordState, bi, wi2);
    const sz2   = szTiny_base * ws2.scale * breathScale;
    const fRest = `italic 400 ${sz2}px 'Playfair Display', serif`;
    ctx.font    = fRest;
    const ww    = ctx.measureText(word).width;
    const pos2  = resolvePos(wi2);
    const cx2   = clampX(pos2.x, ww / 2, ws2);
    const cy2   = clampY(pos2.y, sz2 * 0.6, ws2);
    const aR    = la(STAGGER * 2);
    const eyR   = enterOff(STAGGER * 2);
    const fadeAlpha = aR * (exitP > 0 ? easeOutCubic(1 - exitP) : 1);
    const slideX    = (1 - easeOutCubic(Math.max(0, rel - STAGGER * 2) / FADE_IN)) * W * 0.072;
    ctx.save();
    if (exitP > 0) {
      ctx.translate(cx2, cy2 + eyR + floatY);
      ctx.scale(1 + exitP * 0.06, 1 + exitP * 0.06);
      ctx.translate(-cx2, -(cy2 + eyR + floatY));
    }
    ctx.font         = fRest;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha  = Math.min(1, Math.max(0, fadeAlpha));
    ctx.shadowColor  = 'rgba(255,255,255,1)';
    ctx.shadowBlur   = sz2 * 0.50;
    ctx.fillStyle    = 'rgb(255,255,255)';
    ctx.fillText(word, cx2 + slideX, cy2 + eyR + floatY);
    ctx.restore();
  });
}

// ─── APPLY SAVED WORD/BLOCK STATE FROM FRONTEND ──────────────────────────────
// El frontend manda wordState y blockState con dx/dy/scale ya aplicados
function applyFrontendState(wordState, frontendWordState, frontendBlockState, blocks) {
  blocks.forEach((block, bi) => {
    const bst = frontendBlockState[bi] || { dx: 0, dy: 0, scale: 1.0 };
    block.words.forEach((_, wi) => {
      const fws = (frontendWordState[bi] && frontendWordState[bi][wi]) || {};
      const ws  = getWordState(wordState, bi, wi);
      ws.baseX  = fws.baseX !== undefined ? fws.baseX : null;
      ws.baseY  = fws.baseY !== undefined ? fws.baseY : null;
      ws.dx     = fws.dx    !== undefined ? fws.dx    : bst.dx;
      ws.dy     = fws.dy    !== undefined ? fws.dy    : bst.dy;
      ws.scale  = fws.scale !== undefined ? fws.scale : bst.scale;
    });
  });
}

// ─── RENDER ENDPOINT ──────────────────────────────────────────────────────────
app.post('/render', upload.single('video'), async (req, res) => {
  if (!fontsReady) {
    return res.status(503).json({ error: 'Fuentes no listas todavía. Reintenta en unos segundos.' });
  }

  let data;
  try {
    data = JSON.parse(req.body.data);
  } catch (e) {
    return res.status(400).json({ error: 'JSON inválido en campo data' });
  }

  const { blocks, wordState: fwState, blockState: fbState, videoW, videoH } = data;
  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({ error: 'blocks vacío o inválido' });
  }

  const videoPath = req.file && req.file.path;
  if (!videoPath) return res.status(400).json({ error: 'No se recibió video' });

  const W = videoW || 1280;
  const H = videoH || 720;
  const FPS = 30;

  // Directorios de trabajo para este job
  const jobId  = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const jobDir = path.join(TMP, jobId);
  const framesDir = path.join(jobDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  // Inicializar word state del servidor
  const serverWordState = {};
  applyFrontendState(serverWordState, fwState || {}, fbState || {}, blocks);

  console.log(`[${jobId}] Iniciando render ${W}x${H} @ ${FPS}fps — ${blocks.length} bloques`);

  try {
    // ── 1. Obtener duración del video ────────────────────────────────────────
    let duration;
    try {
      const out = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
        { timeout: 15000 }
      ).toString().trim();
      duration = parseFloat(out);
      if (isNaN(duration) || duration <= 0) throw new Error('duración inválida');
    } catch (e) {
      throw new Error('No se pudo obtener la duración del video: ' + e.message);
    }

    const totalFrames = Math.ceil(duration * FPS);
    console.log(`[${jobId}] Duración: ${duration.toFixed(2)}s — ${totalFrames} frames`);

    // ── 2. Renderizar frames PNG con canvas ──────────────────────────────────
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // Pre-inicializar bases para todos los bloques
    blocks.forEach((_, bi) => initWordBases(ctx, serverWordState, bi, blocks, W, H));

    console.log(`[${jobId}] Generando ${totalFrames} frames PNG...`);
    let lastPct = 0;

    for (let f = 0; f < totalFrames; f++) {
      const t = f / FPS;

      // Canvas transparente — solo subtítulos (el video se compone con FFmpeg)
      ctx.clearRect(0, 0, W, H);

      blocks.forEach((block, bi) => {
        if (t < block.start - 0.25 || t > block.end + 0.6) return;
        drawSubtitles(ctx, W, H, t, blocks, serverWordState, bi);
      });

      // Guardar frame como PNG con canal alpha
      const framePath = path.join(framesDir, `frame_${String(f).padStart(6, '0')}.png`);
      const buffer    = canvas.toBuffer('image/png');
      fs.writeFileSync(framePath, buffer);

      // Log progreso cada 5%
      const pct = Math.round((f / totalFrames) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        console.log(`[${jobId}] Frames: ${pct}% (${f}/${totalFrames})`);
        lastPct = pct;
      }
    }

    console.log(`[${jobId}] Todos los frames generados. Ensamblando con FFmpeg...`);

    // ── 3. FFmpeg: superponer subtítulos (PNG alpha) sobre video original ────
    const outputPath = path.join(jobDir, 'output.mp4');

    // Comando FFmpeg:
    // - Input 0: video original (con audio)
    // - Input 1: secuencia de frames PNG con alpha (subtítulos)
    // - overlay: combina video + subtítulos alpha
    // - libx264 máxima calidad, CRF 18 (visualmente lossless), preset slow
    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        // Video original
        '-i', videoPath,
        // Frames PNG subtítulos (alpha)
        '-framerate', String(FPS),
        '-i', path.join(framesDir, 'frame_%06d.png'),
        // Filtro: overlay de subtítulos sobre video
        '-filter_complex', '[0:v][1:v]overlay=format=auto[v]',
        '-map', '[v]',
        '-map', '0:a?',                    // audio original si existe
        // Codec video: H.264 alta calidad
        '-c:v', 'libx264',
        '-crf', '18',                      // visualmente lossless
        '-preset', 'slow',                 // máxima compresión/calidad
        '-pix_fmt', 'yuv420p',             // compatible con todos los players
        // Codec audio: AAC sin pérdida perceptible
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',         // streaming-ready
        outputPath,
      ];

      console.log(`[${jobId}] FFmpeg args: ${args.join(' ')}`);

      const ff = spawn('ffmpeg', args);
      let stderr = '';
      ff.stderr.on('data', d => { stderr += d.toString(); });
      ff.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error('FFmpeg falló (code ' + code + '): ' + stderr.slice(-1500)));
      });
      ff.on('error', err => reject(new Error('FFmpeg no encontrado: ' + err.message)));
    });

    console.log(`[${jobId}] ✓ Video listo: ${outputPath}`);

    // ── 4. Enviar video al cliente ───────────────────────────────────────────
    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Type',        'video/mp4');
    res.setHeader('Content-Length',      stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="video_subtitulado.mp4"');

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('end', () => {
      // Limpiar archivos temporales
      setTimeout(() => {
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.unlinkSync(videoPath); } catch (_) {}
        console.log(`[${jobId}] Archivos temporales eliminados`);
      }, 5000);
    });

  } catch (err) {
    console.error(`[${jobId}] ERROR:`, err.message);
    // Limpieza en error
    try { fs.rmSync(jobDir,  { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(videoPath); } catch (_) {}

    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`SubtitleBurner server v21 — puerto ${PORT}`);
  await loadFonts();
});
