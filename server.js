const express = require('express');
const multer  = require('multer');
const ffmpeg  = require('fluent-ffmpeg');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const app    = express();
const upload = multer({ dest: os.tmpdir() });

// ── CORS: acepta peticiones desde cualquier origen ────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'ok', service: 'SubtitleBurner Railway' }));

// ── RENDER ENDPOINT ──────────────────────────────────────────────────────────
// POST /render
// multipart/form-data:
//   video   : el archivo de video original
//   data    : JSON string con { blocks, wordState, blockState, videoW, videoH }
app.post('/render', upload.single('video'), async (req, res) => {
  let inputPath  = null;
  let assPath    = null;
  let outputPath = null;

  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió el video.' });

    const data = JSON.parse(req.body.data || '{}');
    const { blocks, wordState, blockState, videoW, videoH } = data;

    if (!blocks || !blocks.length) {
      return res.status(400).json({ error: 'No se recibieron bloques de subtítulos.' });
    }

    inputPath  = req.file.path;
    assPath    = inputPath + '.ass';
    outputPath = inputPath + '_out.mp4';

    const W = videoW || 1280;
    const H = videoH || 720;

    // ── Generar archivo ASS ──────────────────────────────────────────────────
    const assContent = buildASS(blocks, wordState || {}, blockState || {}, W, H);
    fs.writeFileSync(assPath, assContent, 'utf8');

    // ── FFmpeg: quemar subtítulos ASS en el video original ───────────────────
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', `ass=${assPath}`,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '18',          // calidad muy alta (0=lossless, 51=peor)
          '-c:a', 'copy',        // audio sin recodificar
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('end',   resolve)
        .on('error', reject)
        .run();
    });

    // ── Enviar el video renderizado ──────────────────────────────────────────
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

// ── CLEANUP ──────────────────────────────────────────────────────────────────
function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {} });
}

// ── ASS BUILDER ──────────────────────────────────────────────────────────────
// Genera un script ASS con subtítulos que reproducen el mismo layout del canvas.
// Cada palabra es un evento independiente con posición absoluta.
function buildASS(blocks, wordState, blockState, W, H) {
  // ASS resolution igual al video
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Bold,DM Sans,${Math.round(H * 0.038)},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,1,0,3,5,0,0,0,1
Style: BigItalic,Cormorant Garamond,${Math.round(H * 0.095)},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,1,0,3,5,0,0,0,1
Style: SmallItalic,Cormorant Garamond,${Math.round(H * 0.052)},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,1,0,3,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];

  blocks.forEach((block, bi) => {
    const bSt  = blockState[bi] || { dx: 0, dy: 0 };
    const wSts = wordState[bi]  || {};

    const startT = block.start;
    const endT   = block.end + 0.55; // incluye fade-out

    if (block.type === 'B') {
      // ── Tipo B: palabras bold centradas en grilla ─────────────────────────
      const allWords = block.words;
      const mid      = Math.ceil(allWords.length / 2);
      const szBold   = H * 0.038;
      const lineH    = szBold * 1.3;
      const baseCX   = W * 0.5 + bSt.dx;
      const baseCY   = H * 0.5 + bSt.dy;

      // Para ASS con posición relativa, agrupar por líneas
      const line0 = allWords.slice(0, mid);
      const line1 = allWords.slice(mid);

      [line0, line1].forEach((lineWords, lineIdx) => {
        if (!lineWords.length) return;
        const text  = lineWords.join(' ');
        const lineY = baseCY + (lineIdx === 0 ? -lineH * 0.5 : lineH * 0.5);

        // Aplicar offsets de palabras individuales (promedio de la línea)
        let dyAvg = 0;
        lineWords.forEach((_, k) => {
          const wi  = lineIdx === 0 ? k : mid + k;
          const wst = wSts[wi] || { dx: 0, dy: 0 };
          dyAvg += wst.dy;
        });
        dyAvg /= lineWords.length;

        const posX = Math.round(baseCX);
        const posY = Math.round(lineY + dyAvg);

        events.push(
          `Dialogue: 0,${fmtASS(startT)},${fmtASS(endT)},Bold,,0,0,0,,{\\an5\\pos(${posX},${posY})\\fad(180,550)}${text}`
        );
      });

    } else {
      // ── Tipo A: palabra grande (bigIdx) + pequeñas alrededor ─────────────
      const words  = block.words;
      let bigIdx   = 0;
      for (let k = 1; k < words.length; k++) {
        if (words[k].length > words[bigIdx].length) bigIdx = k;
      }

      const szBig  = H * 0.095;
      const szTiny = H * 0.052;
      const lineSmall = szTiny * 1.2;
      const totalH    = lineSmall + szBig + lineSmall * 1.6;
      const baseCX    = W * 0.5 + bSt.dx;
      const baseCY    = H * 0.5 + bSt.dy;
      const blockTop  = baseCY - totalH / 2;
      const yBig      = blockTop + lineSmall + szBig * 0.5;

      // Palabra grande
      const rawBig  = words[bigIdx];
      const wordBig = rawBig.charAt(0).toUpperCase() + rawBig.slice(1).toLowerCase();
      const wstBig  = wSts[bigIdx] || { dx: 0, dy: 0, scale: 1 };
      const bigSzPx = Math.round(szBig * (wstBig.scale || 1));
      const bigX    = Math.round(baseCX + wstBig.dx);
      const bigY    = Math.round(yBig   + wstBig.dy);

      events.push(
        `Dialogue: 0,${fmtASS(startT)},${fmtASS(endT)},BigItalic,,0,0,0,,{\\an5\\pos(${bigX},${bigY})\\fs${bigSzPx}\\fad(180,550)}${wordBig}`
      );

      // Palabras antes (pequeñas)
      const beforeWords = words.slice(0, bigIdx);
      if (beforeWords.length) {
        const text  = beforeWords.join(' ');
        const yBefore = Math.round(blockTop + lineSmall * 0.5);
        // Promedio de offsets del grupo
        let dxAvg = 0, dyAvg = 0;
        beforeWords.forEach((_, k) => {
          const wst = wSts[k] || { dx: 0, dy: 0 };
          dxAvg += wst.dx; dyAvg += wst.dy;
        });
        dxAvg /= beforeWords.length; dyAvg /= beforeWords.length;
        const avgScale = (wSts[0] || { scale: 1 }).scale || 1;
        const tSzPx = Math.round(szTiny * avgScale);

        events.push(
          `Dialogue: 0,${fmtASS(startT)},${fmtASS(endT)},SmallItalic,,0,0,0,,{\\an5\\pos(${Math.round(baseCX + dxAvg)},${Math.round(yBefore + dyAvg)})\\fs${tSzPx}\\fad(180,550)}${text}`
        );
      }

      // Palabras después (pequeñas)
      const afterWords = words.slice(bigIdx + 1);
      if (afterWords.length) {
        const text   = afterWords.join(' ');
        const yAfter = Math.round(blockTop + lineSmall + szBig + lineSmall * 0.8);
        let dxAvg = 0, dyAvg = 0;
        afterWords.forEach((_, k) => {
          const wi  = bigIdx + 1 + k;
          const wst = wSts[wi] || { dx: 0, dy: 0 };
          dxAvg += wst.dx; dyAvg += wst.dy;
        });
        dxAvg /= afterWords.length; dyAvg /= afterWords.length;
        const avgScale = (wSts[bigIdx + 1] || { scale: 1 }).scale || 1;
        const tSzPx = Math.round(szTiny * avgScale);

        events.push(
          `Dialogue: 0,${fmtASS(startT)},${fmtASS(endT)},SmallItalic,,0,0,0,,{\\an5\\pos(${Math.round(baseCX + dxAvg)},${Math.round(yAfter + dyAvg)})\\fs${tSzPx}\\fad(180,550)}${text}`
        );
      }
    }
  });

  return header + events.join('\n') + '\n';
}

// Convierte segundos → formato ASS  H:MM:SS.cc
function fmtASS(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SubtitleBurner server on :${PORT}`));
