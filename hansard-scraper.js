/**
 * Hansard Scraper — hansard.parliament.nz
 *
 * Radware bot protection uses a dynamic "uzlc" token header.
 * Strategy:
 * 1. Playwright loads one real page
 * 2. We intercept the network request to capture uzlc + all headers
 * 3. Reuse those headers for all subsequent API calls via fetch
 * 4. No browser per page — just one warm-up to get the token
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// ── CONFIG ───────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const OPENAI_KEY    = process.env.OPENAI_KEY;

const CHUNK_SIZE    = 400;
const CHUNK_OVERLAP = 50;
const BATCH_SIZE    = 20;
const DELAY_MS      = 1000;
const DAYS_BACK     = 730;

const BASE_URL    = 'https://hansard.parliament.nz';
const API_BASE    = `${BASE_URL}/api/resources/transcript`;
const WARMUP_DATE = '2026-06-24';

const TARGET_MPS = [
  'CHRISTOPHER LUXON', 'NICOLA WILLIS', 'WINSTON PETERS',
  'DAVID SEYMOUR', 'CHRIS BISHOP', 'SHANE JONES',
  'TODD MCCLAY', 'ERICA STANFORD', 'MARK MITCHELL',
  'CHRIS HIPKINS', 'CARMEL SEPULONI', 'WILLIE JACKSON',
  'SIMEON BROWN', 'JUDITH COLLINS', 'LOUISE UPSTON',
  'MATT DOOCEY', 'TAMA POTAKA', 'PAUL GOLDSMITH',
  'SHANE RETI', 'CASEY COSTELLO',
];

// ── CLIENTS ──────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_KEY });

// ── HELPERS ──────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + size).join(' ');
    if (chunk.trim()) chunks.push(chunk);
    i += size - overlap;
  }
  return chunks;
}

function arrayBatch(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) batches.push(arr.slice(i, i + size));
  return batches;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ').replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normaliseName(raw) {
  return raw
    .replace(/^(RT\s+HON|HON|DR|SIR|DAME)\s+/i, '')
    .replace(/,?\s*(KC|QC|MP)$/i, '')
    .trim().toUpperCase();
}

function matchMP(speakerRaw) {
  const n = normaliseName(speakerRaw);
  return TARGET_MPS.find(mp => {
    const last = mp.split(' ').pop();
    return n.includes(last) || n === mp;
  }) || null;
}

function getSittingDayDates(daysBack) {
  const dates = [];
  for (let i = 0; i <= daysBack; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    if (![2, 3, 4].includes(d.getDay())) continue;
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

// ── CAPTURE HEADERS VIA PLAYWRIGHT ───────────────────────────────────────
// Load one real page, intercept the transcript API request,
// capture the exact headers the browser sent (including uzlc token)

async function captureSessionHeaders() {
  console.log('Launching browser to capture session headers...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-NZ',
  });

  const page = await context.newPage();
  let capturedHeaders = null;

  // Intercept all requests — wait for the transcript API call
  page.on('request', request => {
    const url = request.url();
    if (url.includes('/api/resources/transcript/')) {
      const headers = request.headers();
      // Only capture if it has the uzlc token
      if (headers['uzlc']) {
        capturedHeaders = headers;
        console.log(`  Captured uzlc token: ${headers['uzlc'].substring(0, 40)}...`);
      }
    }
  });

  try {
    const warmupUrl = `${BASE_URL}/hansard-transcript/${WARMUP_DATE}?lang=en`;
    await page.goto(warmupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the API call to be made — up to 30 seconds
    const start = Date.now();
    while (!capturedHeaders && Date.now() - start < 30000) {
      await sleep(500);
    }

    if (!capturedHeaders) {
      throw new Error('Could not capture session headers — uzlc token not found');
    }

    console.log(`  Got ${Object.keys(capturedHeaders).length} headers.\n`);
    return capturedHeaders;

  } finally {
    await browser.close();
  }
}

// ── FETCH TRANSCRIPT ─────────────────────────────────────────────────────

async function fetchTranscript(date, sessionHeaders) {
  const url = `${API_BASE}/${date}`;

  const res = await fetch(url, {
    headers: {
      ...sessionHeaders,
      // Override the referer to match the date we're fetching
      'referer': `${BASE_URL}/hansard-transcript/${date}?lang=en`,
    },
  });

  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();

  if (text.includes('Radware') || text.includes('uzdbm') || text.length < 200) {
    throw new Error('bot_protection');
  }

  // Response is a JSON-encoded HTML string
  let html = text;
  if (text.trim().startsWith('"')) {
    html = JSON.parse(text);
  }

  return html;
}

// ── PARSE SPEECHES ───────────────────────────────────────────────────────

function parseSpeeches(html) {
  const speeches = [];

  const speakerBlockRegex = /<span[^>]*class="[^"]*HpsByToc[^"]*"[^>]*>([\s\S]+?)<\/span>\s*:([\s\S]+?)(?=<a name="member"|<span[^>]*HpsByToc|<span[^>]*HpsProceedingHeading|<span[^>]*HpsSubjectHeading|$)/gi;

  let match;
  while ((match = speakerBlockRegex.exec(html)) !== null) {
    const speakerRaw = stripHtml(match[1]).trim();
    const text = stripHtml(match[2]).trim();

    if (text.split(' ').length < 25) continue;

    const namePart = speakerRaw.split('(')[0].trim();
    if (['SPEAKER', 'CLERK', 'CHAIRPERSON', 'ASSISTANT SPEAKER'].some(s => namePart.includes(s))) continue;

    speeches.push({ speakerRaw: namePart, text });
  }

  return speeches;
}

// ── CHECKPOINT ───────────────────────────────────────────────────────────

async function getScrapedDates() {
  const { data, error } = await supabase.from('hansard_scrape_log').select('url');
  if (error) { console.log('Starting fresh.'); return new Set(); }
  return new Set((data || []).map(r => r.url));
}

async function markDateScraped(date, chunksAdded, skipped = false) {
  await supabase.from('hansard_scrape_log').upsert({
    url: date, chunks_added: chunksAdded, skipped,
    scraped_at: new Date().toISOString(),
  }, { onConflict: 'url' });
}

// ── EMBEDDINGS + STORAGE ─────────────────────────────────────────────────

async function embedBatch(texts) {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
  return res.data.map(d => d.embedding);
}

async function storeChunks(chunks) {
  if (!chunks.length) return;
  const { error } = await supabase.from('hansard_chunks').insert(chunks);
  if (error) console.error('  Supabase error:', error.message);
}

async function processDay(date, html) {
  const speeches = parseSpeeches(html);
  const relevant = speeches.map(s => ({ ...s, mpName: matchMP(s.speakerRaw) })).filter(s => s.mpName);

  if (!relevant.length) return 0;

  const allChunks = [];
  for (const speech of relevant) {
    chunkText(speech.text).forEach((content, i) => {
      allChunks.push({
        mp_name: speech.mpName,
        debate_title: `Hansard ${date}`,
        debate_date: date,
        debate_url: `${BASE_URL}/hansard-transcript/${date}?lang=en`,
        chunk_index: i, content, embedding: null,
      });
    });
  }

  if (!allChunks.length) return 0;

  const batches = arrayBatch(allChunks, BATCH_SIZE);
  let idx = 0;
  for (const batch of batches) {
    const embeddings = await embedBatch(batch.map(r => r.content));
    embeddings.forEach((emb, i) => { allChunks[idx + i].embedding = emb; });
    idx += batch.length;
  }

  await storeChunks(allChunks);
  return allChunks.length;
}

// ── MAIN ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Hansard Scraper — Starting         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  let totalChunks = 0, daysProcessed = 0, daysNoSitting = 0, daysErrored = 0;

  // Step 1 — capture real browser headers including uzlc token
  const sessionHeaders = await captureSessionHeaders();

  // Step 2 — checkpoint
  const scrapedDates = await getScrapedDates();
  console.log(`Checkpoint: ${scrapedDates.size} days already indexed.\n`);

  const allDates = getSittingDayDates(DAYS_BACK);
  const toScrape = allDates.filter(d => !scrapedDates.has(d));

  console.log(`Sitting days in range: ${allDates.length}`);
  console.log(`Already scraped:       ${allDates.length - toScrape.length}`);
  console.log(`To scrape now:         ${toScrape.length}\n`);

  let refreshAttempts = 0;

  for (let i = 0; i < toScrape.length; i++) {
    const date = toScrape[i];
    process.stdout.write(`[${i + 1}/${toScrape.length}] ${date} — `);

    try {
      await sleep(DELAY_MS);
      const html = await fetchTranscript(date, sessionHeaders);

      if (!html) {
        process.stdout.write('no sitting\n');
        daysNoSitting++;
        await markDateScraped(date, 0, true);
        continue;
      }

      const chunksAdded = await processDay(date, html);
      await markDateScraped(date, chunksAdded);
      totalChunks += chunksAdded;
      daysProcessed++;
      process.stdout.write(`✓ ${chunksAdded} chunks\n`);
      refreshAttempts = 0; // reset on success

    } catch (err) {
      if (err.message === 'bot_protection' && refreshAttempts < 3) {
        // Token expired — get a fresh one and retry
        process.stdout.write('token expired, refreshing...\n');
        refreshAttempts++;
        try {
          const fresh = await captureSessionHeaders();
          Object.assign(sessionHeaders, fresh);
          i--; // retry this date
        } catch (e) {
          process.stdout.write(`  refresh failed: ${e.message}\n`);
          daysErrored++;
        }
      } else {
        process.stdout.write(`error: ${err.message}\n`);
        daysErrored++;
      }
    }
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  Complete                                ║`);
  console.log(`║  Days with speeches:  ${String(daysProcessed).padEnd(18)}║`);
  console.log(`║  Days no sitting:     ${String(daysNoSitting).padEnd(18)}║`);
  console.log(`║  Days errored:        ${String(daysErrored).padEnd(18)}║`);
  console.log(`║  Total chunks:        ${String(totalChunks).padEnd(18)}║`);
  console.log('╚══════════════════════════════════════════╝\n');

  return { daysProcessed, daysNoSitting, daysErrored, totalChunks };
}

// ── QUERY ────────────────────────────────────────────────────────────────

async function queryHansard(question, mpName = null, limit = 5) {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: [question] });
  const embedding = res.data[0].embedding;
  const { data, error } = await supabase.rpc('match_hansard_chunks', {
    query_embedding: embedding, match_threshold: 0.72,
    match_count: limit, filter_mp: mpName || null,
  });
  if (error) { console.error('Query error:', error.message); return []; }
  return data;
}

module.exports = { run, queryHansard };
if (require.main === module) run().catch(console.error);