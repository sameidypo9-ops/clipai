const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

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
