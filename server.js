const express  = require('express');
const multer   = require('multer');
const ffmpeg   = require('fluent-ffmpeg');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const https    = require('https');
const { execSync } = require('child_process');

const app    = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '10mb' }));

// ── FONT PATHS ────────────────────────────────────────────────────────────────
const FONT_DIR  = path.join(os.tmpdir(), 'sb_fonts');
const FONT_DM   = path.join(FONT_DIR, 'DMSans-Bold.ttf');
const FONT_CG   = path.join(FONT_DIR, 'CormorantGaramond-Italic.ttf');
const FONT_CGS  = path.join(FONT_DIR, 'CormorantGaramond-SemiBoldItalic.ttf');

// Google Fonts direct TTF URLs
const FONT_URLS = [
  { url: 'https://fonts.gstatic.com/s/dmsans/v15/rP2Hp2ywxg089UriCZa4ET-DNl0.woff2',            dest: FONT_DM,  iswoff2: true },
  { url: 'https://fonts.gstatic.com/s/cormorantgaramond/v22/co3bmX5slCNuHLi8bLeY9MK7whWMhyjornFLsS.woff2', dest: FONT_CG,  iswoff2: true },
  { url: 'https://fonts.gstatic.com/s/cormorantgaramond/v22/co3YmX5slCNuHLi8bLeY9MK7whWMhyjYrEOjxA.woff2', dest: FONT_CGS, iswoff2: true },
];

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve();
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

// woff2 → ttf usando fonttools si disponible, o ffmpeg fontconfig
async function ensureFonts() {
  if (!fs.existsSync(FONT_DIR)) fs.mkdirSync(FONT_DIR, { recursive: true });

  // Try to use system fonts first
  const systemFonts = {
    dm:  findSystemFont(['DM Sans', 'DejaVu Sans', 'Liberation Sans', 'Arial', 'FreeSans']),
    cg:  findSystemFont(['Cormorant Garamond', 'DejaVu Serif', 'Liberation Serif', 'FreeSerif', 'Georgia']),
    cgs: findSystemFont(['Cormorant Garamond', 'DejaVu Serif', 'Liberation Serif', 'FreeSerif', 'Georgia']),
  };

  return systemFonts;
}

function findSystemFont(names) {
  for (const name of names) {
    try {
      const result = execSync(`fc-list : family | grep -i "${name}" | head -1`, { encoding: 'utf8' }).trim();
      if (result) {
        // get the file path
        const filePath = execSync(`fc-list "${name}" file | head -1`, { encoding: 'utf8' }).trim();
        if (filePath) {
          const fp = filePath.split(':')[0].trim();
          if (fp && fs.existsSync(fp)) return fp;
        }
      }
    } catch(e) {}
  }
  return null;
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'ok', service: 'SubtitleBurner v2' }));

// ── RENDER ENDPOINT ───────────────────────────────────────────────────────────
app.post('/render', upload.single('video'), async (req, res) => {
  let inputPath  = null;
  let assPath    = null;
  let outputPath = null;

  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió el video.' });

    const data = JSON.parse(req.body.data || '{}');
    const { blocks, wordState, blockState, videoW, videoH } = data;
    if (!blocks || !blocks.length) return res.status(400).json({ error: 'Sin bloques.' });

    inputPath  = req.file.path;
    assPath    = inputPath + '.ass';
    outputPath = inputPath + '_out.mp4';

    const W = videoW || 1280;
    const H = videoH || 720;

    // Get available fonts
    const fonts = await ensureFonts();

    // Build ASS
    const assContent = buildASS(blocks, wordState || {}, blockState || {}, W, H, fonts);
    fs.writeFileSync(assPath, assContent, 'utf8');

    console.log('ASS generated, rendering...');
    console.log('Fonts available:', fonts);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', `ass='${assPath}'`,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '18',
          '-c:a', 'copy',
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('start', cmd => console.log('FFmpeg cmd:', cmd))
        .on('end',   resolve)
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg error:', err.message);
          console.error('stderr:', stderr);
          reject(err);
        })
        .run();
    });

    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Type',        'video/mp4');
    res.setHeader('Content-Length',      stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="video_subtitulado.mp4"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => cleanup(inputPath, assPath, outputPath));

  } catch (err) {
    console.error('Error render:', err);
    cleanup(inputPath, assPath, outputPath);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Error interno.' });
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────
function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {} });
}

// ── ASS BUILDER ───────────────────────────────────────────────────────────────
function buildASS(blocks, wordState, blockState, W, H, fonts) {

  // Font names for ASS — use what's available
  const fontBold    = 'DM Sans';
  const fontSerif   = 'Cormorant Garamond';

  // Sizes matching the canvas exactly
  const szBoldBase  = Math.round(H * 0.038);
  const szBigBase   = Math.round(H * 0.095);
  const szTinyBase  = Math.round(H * 0.052);

  // White with full opacity in ASS format: &H00FFFFFF
  // Shadow: soft white glow simulated via outline+shadow
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TypeB,${fontBold},${szBoldBase},&H00FFFFFF,&H000000FF,&H40000000,&H00000000,-1,0,1,1.5,2,5,0,0,0,1
Style: TypeA_Big,${fontSerif},${szBigBase},&H00FFFFFF,&H000000FF,&H40000000,&H00000000,0,-1,1,1.5,2,5,0,0,0,1
Style: TypeA_Small,${fontSerif},${szTinyBase},&H00FFFFFF,&H000000FF,&H40000000,&H00000000,0,-1,1,1,1.5,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];

  blocks.forEach((block, bi) => {
    const bSt  = blockState[bi] || { dx: 0, dy: 0 };
    const wSts = wordState[bi]  || {};

    const startT = block.start;
    const endT   = block.end + 0.55;

    if (block.type === 'B') {
      // ── TYPE B: DM Sans Bold, grilla de 2 líneas ─────────────────────────
      const allWords = block.words;
      const mid      = Math.ceil(allWords.length / 2);
      const szBold   = szBoldBase;
      const lineH    = szBold * 1.3;
      const baseCX   = W * 0.5 + bSt.dx;
      const baseCY   = H * 0.5 + bSt.dy;

      const lines = [allWords.slice(0, mid), allWords.slice(mid)];
      lines.forEach((lineWords, lineIdx) => {
        if (!lineWords.length) return;

        let dyAvg = 0, dxAvg = 0, scaleAvg = 1;
        lineWords.forEach((_, k) => {
          const wi  = lineIdx === 0 ? k : mid + k;
          const wst = wSts[wi] || { dx: 0, dy: 0, scale: 1 };
          dxAvg += (wst.dx || 0);
          dyAvg += (wst.dy || 0);
          scaleAvg += ((wst.scale || 1) - 1);
        });
        dxAvg    /= lineWords.length;
        dyAvg    /= lineWords.length;
        scaleAvg  = 1 + (scaleAvg - 1) / lineWords.length;

        const posX   = Math.round(baseCX + dxAvg);
        const lineY  = baseCY + (lineIdx === 0 ? -lineH * 0.5 : lineH * 0.5);
        const posY   = Math.round(lineY + dyAvg);
        const fscale = Math.round(scaleAvg * 100);
        const text   = lineWords.join(' ');

        events.push(
          `Dialogue: 0,${fmtASS(startT)},${fmtASS(endT)},TypeB,,0,0,0,,` +
          `{\\an5\\pos(${posX},${posY})\\fscx${fscale}\\fscy${fscale}\\fad(180,550)}${text}`
        );
      });

    } else {
      // ── TYPE A: Cormorant Garamond Italic ─────────────────────────────────
      const words = block.words;
      if (!words.length) return;

      let bigIdx = 0;
      for (let k = 1; k < words.length; k++) {
        if (words[k].length > words[bigIdx].length) bigIdx = k;
      }

      const szBig      = szBigBase;
      const szTiny     = szTinyBase;
      const lineSmall  = szTiny * 1.2;
      const totalH     = lineSmall + szBig + lineSmall * 1.6;
      const baseCX     = W * 0.5 + bSt.dx;
      const baseCY     = H * 0.5 + bSt.dy;
      const blockTop   = baseCY - totalH / 2;
      const yBig       = blockTop + lineSmall + szBig * 0.5;

      // ── Palabra grande ────────────────────────────────────────────────────
      const rawBig  = words[bigIdx];
      const wordBig = rawBig.charAt(0).toUpperCase() + rawBig.slice(1).toLowerCase();
      const wstBig  = wSts[bigIdx] || { dx: 0, dy: 0, scale: 1 };
      const bigScale = Math.round((wstBig.scale || 1) * 100);
      const bigFsz   = Math.round(szBig * (wstBig.scale || 1));
      const bigX     = Math.round(baseCX + (wstBig.dx || 0));
      const bigY     = Math.round(yBig   + (wstBig.dy || 0));

      events.push(
        `Dialogue: 0,${fmtASS(startT)},${fmtASS(endT)},TypeA_Big,,0,0,0,,` +
        `{\\an5\\pos(${bigX},${bigY})\\fs${bigFsz}\\fad(180,550)}${wordBig}`
      );

      // ── Palabras antes ────────────────────────────────────────────────────
      const beforeWords = words.slice(0, bigIdx);
      if (beforeWords.length) {
        let dxAvg = 0, dyAvg = 0, scAvg = 1;
        beforeWords.forEach((_, k) => {
          const wst = wSts[k] || { dx: 0, dy: 0, scale: 1 };
          dxAvg += (wst.dx || 0); dyAvg += (wst.dy || 0); scAvg += ((wst.scale||1)-1);
        });
        dxAvg /= beforeWords.length; dyAvg /= beforeWords.length;
        scAvg  = 1 + (scAvg - 1) / beforeWords.length;
        const tFsz   = Math.round(szTiny * scAvg);
        const yBefore = Math.round(blockTop + lineSmall * 0.5 + dyAvg);
        const xBefore = Math.round(baseCX + dxAvg);

        events.push(
          `Dialogue: 0,${fmtASS(startT)},${fmtASS(endT)},TypeA_Small,,0,0,0,,` +
          `{\\an5\\pos(${xBefore},${yBefore})\\fs${tFsz}\\fad(180,550)}${beforeWords.join(' ')}`
        );
      }

      // ── Palabras después ──────────────────────────────────────────────────
      const afterWords = words.slice(bigIdx + 1);
      if (afterWords.length) {
        let dxAvg = 0, dyAvg = 0, scAvg = 1;
        afterWords.forEach((_, k) => {
          const wi  = bigIdx + 1 + k;
          const wst = wSts[wi] || { dx: 0, dy: 0, scale: 1 };
          dxAvg += (wst.dx || 0); dyAvg += (wst.dy || 0); scAvg += ((wst.scale||1)-1);
        });
        dxAvg /= afterWords.length; dyAvg /= afterWords.length;
        scAvg  = 1 + (scAvg - 1) / afterWords.length;
        const tFsz   = Math.round(szTiny * scAvg);
        const yAfter = Math.round(blockTop + lineSmall + szBig + lineSmall * 0.8 + dyAvg);
        const xAfter = Math.round(baseCX + dxAvg);

        events.push(
          `Dialogue: 0,${fmtASS(startT)},${fmtASS(endT)},TypeA_Small,,0,0,0,,` +
          `{\\an5\\pos(${xAfter},${yAfter})\\fs${tFsz}\\fad(180,550)}${afterWords.join(' ')}`
        );
      }
    }
  });

  return header + events.join('\n') + '\n';
}

// Convierte segundos → H:MM:SS.cc
function fmtASS(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SubtitleBurner v2 on :${PORT}`);
  // Log available fonts on startup
  try {
    const fonts = execSync('fc-list | grep -iE "DM Sans|Cormorant|DejaVu|Liberation" | head -20', { encoding: 'utf8' });
    console.log('Available fonts:', fonts);
  } catch(e) {
    console.log('Could not list fonts');
  }
});
