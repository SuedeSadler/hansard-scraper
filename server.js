const express = require('express');
const { run } = require('./hansard-scraper');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/scrape', async (req, res) => {
  if (API_SECRET && req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ status: 'started', message: 'Scrape job running in background' });
  try {
    console.log('Scrape triggered at', new Date().toISOString());
    await run();
    console.log('Scrape completed at', new Date().toISOString());
  } catch (err) {
    console.error('Scrape failed:', err.message);
  }
});

app.get('/debug/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const response = await fetch(`https://hansard.parliament.nz/api/resources/transcript/${date}`);
    const text = await response.text();
    const preview = text.substring(0, 3000);
    res.send(`<pre>${preview.replace(/</g, '&lt;')}</pre>`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Hansard scraper server running on port ${PORT}`);
});