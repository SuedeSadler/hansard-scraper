const express = require('express');
const { run } = require('./hansard-scraper');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Simple auth to stop random people triggering your scraper
const API_SECRET = process.env.API_SECRET;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/scrape', async (req, res) => {
  // Check secret header
  if (API_SECRET && req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond immediately so n8n doesn't time out
  // Scraper runs in the background
  res.json({ status: 'started', message: 'Scrape job running in background' });

  try {
    console.log('Scrape triggered at', new Date().toISOString());
    await run();
    console.log('Scrape completed at', new Date().toISOString());
  } catch (err) {
    console.error('Scrape failed:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Hansard scraper server running on port ${PORT}`);
});
