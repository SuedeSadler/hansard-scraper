const express = require('express');
const { runWithHeaders } = require('./hansard-scraper');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Accepts sessionHeaders in the POST body — passed from your local machine
app.post('/scrape', async (req, res) => {
  if (API_SECRET && req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { sessionHeaders } = req.body || {};

  if (!sessionHeaders || !sessionHeaders['uzlc']) {
    return res.status(400).json({ error: 'Missing sessionHeaders with uzlc token. Run grab-token.js locally first.' });
  }

  res.json({ status: 'started', message: 'Scrape job running in background' });

  try {
    console.log('Scrape triggered with uzlc token:', sessionHeaders['uzlc'].substring(0, 40) + '...');
    await runWithHeaders(sessionHeaders);
    console.log('Scrape completed at', new Date().toISOString());
  } catch (err) {
    console.error('Scrape failed:', err.message);
  }
});

app.get('/debug/:date', async (req, res) => {
  res.status(400).json({ error: 'Debug endpoint requires sessionHeaders. Use grab-token.js locally.' });
});

app.listen(PORT, () => {
  console.log(`Hansard scraper server running on port ${PORT}`);
});