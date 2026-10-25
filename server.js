import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Detección automática del binario yt-dlp (Render/Linux vs Windows local)
let YTDLP_PATH = 'yt-dlp';
const localWinYtdlp = 'C:\\Users\\PC\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe';
if (process.platform === 'win32' && fs.existsSync(localWinYtdlp)) {
  YTDLP_PATH = localWinYtdlp;
}

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// Health check para Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Rapio Backend' });
});

// 1. Endpoint TikTok (con soporte de Video HD y Audio MP3)
app.post('/api/tiktok', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.includes('tiktok.com')) {
    return res.status(400).json({ error: 'Por favor ingresa un enlace válido de TikTok.' });
  }

  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.code === 0 && data.data) {
      const info = data.data;
      return res.json({
        success: true,
        type: 'tiktok',
        title: info.title || 'Video de TikTok',
        author: info.author ? info.author.nickname : 'TikTok User',
        cover: info.cover,
        videoHD: info.hdplay || info.play,
        music: info.music,
        duration: info.duration
      });
    } else {
      return res.status(422).json({ error: data.msg || 'No se pudo procesar el video de TikTok.' });
    }
  } catch (err) {
    console.error('Error TikTok:', err);
    return res.status(500).json({ error: 'Error del servidor al procesar TikTok.' });
  }
});

// Caché en memoria (15 minutos) para respuestas en <10ms
const metadataCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function getCached(url) {
  const item = metadataCache.get(url);
  if (item && Date.now() - item.ts < CACHE_TTL) return item.data;
  return null;
}

function setCache(url, data) {
  if (metadataCache.size > 500) {
    const oldestKey = metadataCache.keys().next().value;
    metadataCache.delete(oldestKey);
  }
  metadataCache.set(url, { ts: Date.now(), data });
}

// Fast-path para X / Twitter usando api.vxtwitter.com (~200ms vs 3.5s de yt-dlp)
async function extractTwitterFast(url) {
  try {
    const u = new URL(url);
    const apiUrl = `https://api.vxtwitter.com${u.pathname}`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.media_extended && data.media_extended.length > 0) {
      const vid = data.media_extended.find(m => m.type === 'video' || m.type === 'gif') || data.media_extended[0];
      if (vid && vid.url) {
        return {
          title: data.text ? data.text.slice(0, 80) : 'Video de X (Twitter)',
          author: data.user_screen_name || data.user_name || 'X User',
          cover: vid.thumbnail_url || '',
          videoHD: vid.url,
          music: vid.url,
          audioTrack: null,
          resolutions: null
        };
      }
    }
  } catch (e) {}
  return null;
}

// Helper genérico ultrarrápido para extraer con yt-dlp (Instagram, Facebook, YouTube y X)
async function extractWithYtdlp(url, platformName) {
  const cached = getCached(url);
  if (cached) return cached;

  if (platformName === 'X (Twitter)') {
    const fastTw = await extractTwitterFast(url);
    if (fastTw) {
      setCache(url, fastTw);
      return fastTw;
    }
  }

  const isYT = platformName === 'YouTube';
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--geo-bypass',
    '--socket-timeout', '10'
  ];

  if (hasCookies) {
    args.push('--cookies', cookiesPath);
  }

  if (isYT) {
    // Usar solo cliente android reduce las peticiones de red internas de 3 a 1 (3x más rápido)
    args.push('--extractor-args', 'youtube:player_client=android;player_skip=webpage,configs');
  }

  args.push(url);

  const { stdout } = await execFileAsync(YTDLP_PATH, args, { timeout: 25000 });

  const metadata = JSON.parse(stdout);

  let videoUrl = metadata.url;
  let audioUrl = null;
  const resolutions = [];

  if (metadata.formats && metadata.formats.length > 0) {
    // 1. Buscar audio
    const audioFormats = metadata.formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.url);
    if (audioFormats.length > 0) {
      audioUrl = audioFormats[audioFormats.length - 1].url;
    }

    // 2. Buscar formatos de video progresivos (con video Y audio)
    const videoWithAudio = metadata.formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url);
    if (videoWithAudio.length > 0) {
      videoUrl = videoWithAudio[videoWithAudio.length - 1].url;
      const seen = new Set();
      videoWithAudio.forEach(f => {
        const height = f.height || 0;
        if (height >= 144 && !seen.has(height)) {
          seen.add(height);
          resolutions.push({
            quality: `${height}p`,
            height: height,
            url: f.url
          });
        }
      });
    } else {
      // Si no hay video combinado progresivo (ej. DASH separado en Instagram/Facebook):
      const videoFormats = metadata.formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.url);
      if (videoFormats.length > 0) {
        videoUrl = videoFormats[videoFormats.length - 1].url;
      }
    }
  }

  resolutions.sort((a, b) => b.height - a.height);

  if (!audioUrl && metadata.requested_formats) {
    const audioReq = metadata.requested_formats.find(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url);
    if (audioReq) audioUrl = audioReq.url;
  }

  if (!audioUrl && videoUrl) {
    audioUrl = videoUrl;
  }

  const result = {
    title: metadata.title || metadata.description?.slice(0, 80) || `Video de ${platformName}`,
    author: metadata.uploader || metadata.channel || `${platformName} User`,
    cover: metadata.thumbnail || '',
    videoHD: videoUrl,
    music: audioUrl,
    audioTrack: (metadata.requested_formats && metadata.requested_formats.find(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url)?.url) || (metadata.formats && metadata.formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.url).pop()?.url) || null,
    resolutions: resolutions.length > 0 ? resolutions : null
  };
  setCache(url, result);
  return result;
}

// 2. Endpoint Instagram (Reels, Videos con MP3)
app.post('/api/instagram', async (req, res) => {
  const { url } = req.body;

  if (!url || (!url.includes('instagram.com') && !url.includes('instagr.am'))) {
    return res.status(400).json({ error: 'Por favor ingresa un enlace válido de Instagram.' });
  }

  try {
    const data = await extractWithYtdlp(url, 'Instagram');
    if (data.videoHD) {
      return res.json({
        success: true,
        type: 'instagram',
        ...data
      });
    } else {
      return res.status(422).json({ error: 'No se encontró video en el enlace de Instagram proporcionado.' });
    }
  } catch (err) {
    console.error('Error Instagram:', err.stderr || err.message);
    return res.status(422).json({
      error: 'Error al procesar el enlace de Instagram. Verifica que el Reel o publicación sea público.'
    });
  }
});

// 3. Endpoint Facebook (Reels, Videos con MP3)
app.post('/api/facebook', async (req, res) => {
  const { url } = req.body;

  if (!url || (!url.includes('facebook.com') && !url.includes('fb.watch') && !url.includes('fb.gg'))) {
    return res.status(400).json({ error: 'Por favor ingresa un enlace válido de Facebook o FB Watch.' });
  }

  try {
    const data = await extractWithYtdlp(url, 'Facebook');
    if (data.videoHD) {
      return res.json({
        success: true,
        type: 'facebook',
        ...data
      });
    } else {
      return res.status(422).json({ error: 'No se encontró stream de video en el enlace de Facebook proporcionado.' });
    }
  } catch (err) {
    console.error('Error Facebook:', err.stderr || err.message);
    return res.status(422).json({
      error: 'Error al procesar el video de Facebook. Verifica que el Reel o video sea público.'
    });
  }
});

// 4. Endpoint YouTube (Videos, Shorts con selector de resolución y MP3)
app.post('/api/youtube', async (req, res) => {
  const { url } = req.body;

  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.status(400).json({ error: 'Por favor ingresa un enlace válido de YouTube o YouTube Shorts.' });
  }

  try {
    const data = await extractWithYtdlp(url, 'YouTube');
    if (data.videoHD || data.music) {
      return res.json({
        success: true,
        type: 'youtube',
        ...data
      });
    } else {
      return res.status(422).json({ error: 'No se pudo obtener información del video de YouTube.' });
    }
  } catch (err) {
    console.error('Error YouTube:', err.stderr || err.message);
    return res.status(422).json({
      error: 'Error al procesar el video de YouTube. Verifica que no sea privado o restringido por edad.'
    });
  }
});

// 5. Endpoint X / Twitter (Videos, Clips con MP3)
app.post('/api/twitter', async (req, res) => {
  const { url } = req.body;

  if (!url || (!url.includes('twitter.com') && !url.includes('x.com'))) {
    return res.status(400).json({ error: 'Por favor ingresa un enlace válido de X o Twitter.' });
  }

  try {
    const data = await extractWithYtdlp(url, 'X (Twitter)');
    if (data.videoHD) {
      return res.json({
        success: true,
        type: 'twitter',
        ...data
      });
    } else {
      return res.status(422).json({ error: 'No se encontró video en la publicación de X proporcionada.' });
    }
  } catch (err) {
    console.error('Error Twitter/X:', err.stderr || err.message);
    return res.status(422).json({
      error: 'Error al procesar el video de X (Twitter). Verifica que la publicación contenga video y sea pública.'
    });
  }
});

// Proxy para forzar descarga directa con streaming en vivo y transcodificación rápida
app.get('/api/stream-file', async (req, res) => {
  const { url, audio, filename } = req.query;

  if (!url) {
    return res.status(400).send('URL requerida');
  }

  const isAudio = filename && filename.toLowerCase().endsWith('.mp3');
  const safeFilename = filename || (isAudio ? 'audio.mp3' : 'video.mp4');

  // Si se solicita MP3
  if (isAudio) {
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', 'audio/mpeg');

    const ffmpegProc = spawn('ffmpeg', [
      '-i', url,
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      '-f', 'mp3',
      'pipe:1'
    ]);

    ffmpegProc.stdout.pipe(res);
    ffmpegProc.stderr.on('data', () => {});
    ffmpegProc.on('error', (err) => {
      console.error('Error spawn ffmpeg audio:', err);
      if (!res.headersSent) res.status(500).send('Error procesando audio');
    });

    req.on('close', () => {
      try { ffmpegProc.kill(); } catch (e) {}
    });
    return;
  }

  // Para video (MP4)
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.setHeader('Content-Type', 'video/mp4');

  // Si viene una pista de audio separada (como pasa en Instagram o Facebook DASH),
  // FFmpeg une video + audio al vuelo en tiempo real:
  const ffmpegArgs = ['-i', url];
  if (audio && audio !== url) {
    ffmpegArgs.push('-i', audio);
    ffmpegArgs.push('-c:v', 'copy', '-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0?');
  } else {
    ffmpegArgs.push('-c', 'copy');
  }
  ffmpegArgs.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1');

  const ffmpegProc = spawn('ffmpeg', ffmpegArgs);

  ffmpegProc.stdout.pipe(res);
  ffmpegProc.stderr.on('data', () => {});
  ffmpegProc.on('error', (err) => {
    console.error('Error spawn ffmpeg video:', err);
    if (!res.headersSent) res.status(500).send('Error procesando video');
  });

  req.on('close', () => {
    try { ffmpegProc.kill(); } catch (e) {}
  });
});

app.listen(PORT, () => {
  console.log(`Servidor de Rapio corriendo en el puerto ${PORT}`);
});
