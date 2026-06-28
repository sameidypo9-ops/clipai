const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static files from current directory
app.use(express.static(process.cwd()));

// Root route for debugging
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'video-editor.html'));
});

// Create temp directory for downloads
const tempDir = path.join(process.cwd(), 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Clean up old files periodically
setInterval(() => {
  if (fs.existsSync(tempDir)) {
    fs.readdirSync(tempDir).forEach(file => {
      const filepath = path.join(tempDir, file);
      const stat = fs.statSync(filepath);
      // Remove files older than 1 hour
      if (Date.now() - stat.mtimeMs > 3600000) {
        fs.unlinkSync(filepath);
      }
    });
  }
}, 600000); // Check every 10 minutes

// Download video endpoint
app.post('/api/download', async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Check if it's a direct video file URL
  if (url.match(/\.(mp4|webm|mov|avi)(\?.*)?$/i)) {
    return res.json({ videoUrl: url, format: 'direct' });
  }

  // Handle YouTube and other platforms
  const filename = `video_${Date.now()}.mp4`;
  const filepath = path.join(tempDir, filename);

  try {
    // Use yt-dlp to download video
    const ytdlp = spawn('yt-dlp', [
      '-f', 'best[ext=mp4]/best',
      '-o', filepath,
      '--quiet',
      '--no-warnings',
      url
    ]);

    let error = '';
    ytdlp.stderr.on('data', (data) => {
      error += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && fs.existsSync(filepath)) {
        // Check file size (max 500MB for safety)
        const stats = fs.statSync(filepath);
        if (stats.size > 500 * 1024 * 1024) {
          fs.unlinkSync(filepath);
          return res.status(413).json({ error: 'Video file too large (max 500MB)' });
        }
        
        // Return relative URL that the frontend can use
        const videoUrl = `/temp/${filename}`;
        res.json({ videoUrl, format: 'downloaded', filename });
      } else {
        res.status(400).json({ 
          error: 'Failed to download video. Ensure the URL is valid and public.',
          details: error.substring(0, 200)
        });
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Download failed: ' + err.message });
  }
});

// Serve downloaded videos
app.use('/temp', express.static(tempDir));

// Extract and download clips endpoint
app.post('/api/extract-clips', async (req, res) => {
  const { videoUrl, clips } = req.body;
  
  if (!videoUrl || !clips || clips.length === 0) {
    return res.status(400).json({ error: 'Video URL and clips are required' });
  }

  const sessionId = `session_${Date.now()}`;
  const sessionDir = path.join(process.cwd(), 'downloads', sessionId);
  
  try {
    // Create session directory
    if (!fs.existsSync(path.join(process.cwd(), 'downloads'))) {
      fs.mkdirSync(path.join(process.cwd(), 'downloads'), { recursive: true });
    }
    fs.mkdirSync(sessionDir, { recursive: true });

    // Check if video is already downloaded or is direct URL
    let localVideoPath = videoUrl;
    if (videoUrl.startsWith('/temp/')) {
      localVideoPath = path.join(process.cwd(), videoUrl);
    }

    // Extract each clip
    const clipPaths = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const clipNum = (i + 1).toString().padStart(2, '0');
      const clipName = clip.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 30);
      const clipPath = path.join(sessionDir, `clip_${clipNum}_${clipName}.mp4`);

      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i', localVideoPath,
          '-ss', Math.floor(clip.start).toString(),
          '-t', Math.round(clip.end - clip.start).toString(),
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-crf', '28',
          '-preset', 'medium',
          '-movflags', '+faststart',
          clipPath
        ]);

        ffmpeg.stderr.on('data', (data) => {
          console.log(`ffmpeg: ${data}`);
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            clipPaths.push(clipPath);
            resolve();
          } else {
            reject(new Error(`ffmpeg failed for clip ${clipNum}`));
          }
        });
      });
    }

    // Create ZIP file
    const zipPath = path.join(sessionDir, 'clips.zip');
    const zipStream = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.pipe(zipStream);
    
    clipPaths.forEach((clipPath, i) => {
      const clipNum = (i + 1).toString().padStart(2, '0');
      const clipName = path.basename(clipPath);
      archive.file(clipPath, { name: clipName });
    });

    archive.finalize();

    zipStream.on('close', () => {
      const zipSize = fs.statSync(zipPath).size;
      console.log(`✅ Created ZIP: ${zipSize} bytes`);
      
      // Return download link
      res.json({ 
        downloadUrl: `/downloads/${sessionId}/clips.zip`,
        clipCount: clips.length,
        message: `Ready to download ${clips.length} clips`
      });

      // Clean up after 24 hours
      setTimeout(() => {
        try {
          fs.rmSync(sessionDir, { recursive: true });
        } catch (e) {}
      }, 24 * 60 * 60 * 1000);
    });

    zipStream.on('error', (err) => {
      res.status(500).json({ error: 'Failed to create ZIP: ' + err.message });
    });

  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({ error: 'Extraction failed: ' + err.message });
  }
});

// Serve downloads
app.use('/downloads', express.static(path.join(process.cwd(), 'downloads')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`✅ ClipAI server running on port ${PORT}`);
  console.log(`📁 Temp directory: ${tempDir}`);
  console.log(`🎬 Ready to accept video downloads`);
});

// Handle errors
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught error:', err);
});
