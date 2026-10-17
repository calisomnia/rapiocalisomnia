import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
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
app.use(express.static(path.join(__dirname, 'public')));

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

// Helper genérico para extraer con yt-dlp (Instagram, Facebook y YouTube)
async function extractWithYtdlp(url, platformName) {
  const { stdout } = await execFileAsync(YTDLP_PATH, [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    url
  ], { timeout: 45000 });

  const metadata = JSON.parse(stdout);

  let videoUrl = metadata.url;
  let audioUrl = null;
  const resolutions = [];

  if (metadata.formats && metadata.formats.length > 0) {
    // 1. Buscar audio
    const audioFormats = metadata.formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
    if (audioFormats.length > 0) {
      audioUrl = audioFormats[audioFormats.length - 1].url;
    }

    // 2. Buscar formatos de video progresivos
    const videoWithAudio = metadata.formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');
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
      const videoFormats = metadata.formats.filter(f => f.vcodec && f.vcodec !== 'none');
      if (videoFormats.length > 0) {
        videoUrl = videoFormats[videoFormats.length - 1].url;
      }
    }
  }

  resolutions.sort((a, b) => b.height - a.height);

  if (!audioUrl && metadata.requested_formats) {
    const audioReq = metadata.requested_formats.find(f => f.vcodec === 'none' && f.acodec !== 'none');
    if (audioReq) audioUrl = audioReq.url;
  }

  if (!audioUrl && videoUrl) {
    audioUrl = videoUrl;
  }

  return {
    title: metadata.title || metadata.description?.slice(0, 80) || `Video de ${platformName}`,
    author: metadata.uploader || metadata.channel || `${platformName} User`,
    cover: metadata.thumbnail || '',
    videoHD: videoUrl,
    music: audioUrl,
    resolutions: resolutions.length > 0 ? resolutions : null
  };
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

// Proxy para forzar descarga directa sin abrir pestaña
app.get('/api/stream-file', async (req, res) => {
  const { url, filename } = req.query;

  if (!url) {
    return res.status(400).send('URL requerida');
  }

  try {
    const fileRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!fileRes.ok) {
      return res.status(fileRes.status).send('Error al obtener el recurso remoto');
    }

    const safeFilename = filename || (url.includes('.mp3') ? 'audio.mp3' : 'video.mp4');
    const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';

    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Type', contentType);

    const arrayBuffer = await fileRes.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Error transmitiendo archivo:', error);
    return res.status(500).send('Error al descargar el archivo.');
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de Rapio corriendo en el puerto ${PORT}`);
});
