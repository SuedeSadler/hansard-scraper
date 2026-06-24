/**
 * Hansard Scraper — hansard.parliament.nz
 *
 * Generates sitting day URLs directly from dates (no listing page needed),
 * scrapes each transcript with Playwright, parses speeches by MP,
 * batch embeds via OpenAI, and stores in Supabase pgvector.
 *
 * Features:
 * - Date-based URL generation — no listing page crawling
 * - Checkpoint system — restarts pick up where they left off
 * - Batched embeddings — 20 chunks per API call
 * - Skips non-sitting days automatically
 *
 * Setup:
 *   npm install playwright @supabase/supabase-js openai
 *   npx playwright install chromium
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// ── CONFIG ───────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const OPENAI_KEY    = process.env.OPENAI_KEY;

const CHUNK_SIZE    = 400;   // words per chunk
const CHUNK_OVERLAP = 50;    // word overlap between chunks
const BATCH_SIZE    = 20;    // chunks per OpenAI embedding call
const DELAY_MS      = 2000;  // ms between page requests
const DAYS_BACK     = 730;   // 2 years for initial scrape, change to 14 for weekly

const BASE_URL = 'https://hansard.parliament.nz';

// MPs to track
const TARGET_MPS = [
  'CHRISTOPHER LUXON',
  'NICOLA WILLIS',
  'WINSTON PETERS',
  'DAVID SEYMOUR',
  'CHRIS BISHOP',
  'SHANE JONES',
  'TODD MCCLAY',
  'ERICA STANFORD',
  'MARK MITCHELL',
  'CHRIS HIPKINS',
  'CARMEL SEPULONI',
  'WILLIE JACKSON',
  'SIMEON BROWN',
  'JUDITH COLLINS',
  'LOUISE UPSTON',
  'MATT DOOCEY',
  'TAMA POTAKA',
  'PAUL GOLDSMITH',
  'SHANE RETI',
  'CASEY COSTELLO',
];

// ── CLIENTS ──────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_KEY });

// ── HELPERS ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + size).join(' ');
    if (chunk.trim().length > 0) chunks.push(chunk);
    i += size - overlap;
  }
  return chunks;
}

function arrayBatch(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

function normaliseName(raw) {
  return raw
    .replace(/^(RT\s+HON|HON|DR|SIR|DAME)\s+/i, '')
    .replace(/,?\s*(KC|QC|MP)$/i, '')
    .trim()
    .toUpperCase();
}

function matchMP(speakerRaw) {
  const normalised = normaliseName(speakerRaw);
  return TARGET_MPS.find(mp => {
    const lastName = mp.split(' ').pop();
    return normalised.includes(lastName) || normalised === mp;
  }) || null;
}

// ── URL GENERATION ───────────────────────────────────────────────────────
// Parliament sits Tuesday (2), Wednesday (3), Thursday (4)
// Generate URLs for all potential sitting days in range

function getSittingDayUrls(daysBack) {
  const urls = [];
  const today = new Date();

  for (let i = 0; i <= daysBack; i++) {
    const d = new Date();
    d.setDate(today.getDate() - i);

    const dayOfWeek = d.getDay();
    if (![2, 3, 4].includes(dayOfWeek)) continue;

    const dateStr = d.toISOString().split('T')[0];
    urls.push({
      url: `${BASE_URL}/hansard-transcript/${dateStr}?lang=en`,
      date: dateStr,
      title: `Hansard ${dateStr}`,
    });
  }

  return urls;
}

// ── SPEECH PARSER ────────────────────────────────────────────────────────
// Handles Hansard format:
// SPEAKER NAME (Role/Party—Electorate) (HH:MM): Speech text...

function parseSpeeches(fullText) {
  const speeches = [];

  const speechRegex = /^([A-Z][A-Z\s\-\.\']+?)\s*\([^)]*\)\s*(?:\([0-9]{2}:[0-9]{2}\))?\s*(?:to [^:]+)?:\s*([\s\S]+?)(?=\n[A-Z][A-Z\s\-\.\']{4,}\s*\(|$)/gm;

  let match;
  while ((match = speechRegex.exec(fullText)) !== null) {
    const speakerRaw = match[1].trim();
    const text = match[2].trim().replace(/\n+/g, ' ');

    // Skip short content and procedural speakers
    if (text.split(' ').length < 25) continue;
    if (['SPEAKER', 'CLERK', 'CHAIRPERSON', 'ASSISTANT SPEAKER'].some(s => speakerRaw.includes(s))) continue;

    speeches.push({ speakerRaw, text });
  }

  return speeches;
}

// ── CHECKPOINT ───────────────────────────────────────────────────────────

async function getScrapedUrls() {
  const { data, error } = await supabase
    .from('hansard_scrape_log')
    .select('url');

  if (error) {
    console.log('No scrape log found — starting fresh.');
    return new Set();
  }

  return new Set((data || []).map(r => r.url));
}

async function markUrlScraped(url, chunksAdded, skipped = false) {
  await supabase.from('hansard_scrape_log').upsert({
    url,
    chunks_added: chunksAdded,
    skipped,
    scraped_at: new Date().toISOString(),
  }, { onConflict: 'url' });
}

// ── EMBEDDINGS ───────────────────────────────────────────────────────────

async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return res.data.map(d => d.embedding);
}

// ── STORAGE ──────────────────────────────────────────────────────────────

async function storeChunks(chunks) {
  if (chunks.length === 0) return;
  const { error } = await supabase.from('hansard_chunks').insert(chunks);
  if (error) console.error('  Supabase error:', error.message);
}

// ── SCRAPE A SINGLE DAY ──────────────────────────────────────────────────

async function scrapeDay(page, { url, date, title }) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for content to render — hansard.parliament.nz is a JS app
    // Try to wait for speech content to appear
    try {
      await page.waitForSelector('p, .speech, .contribution, [class*="debate"]', { timeout: 15000 });
    } catch {
      // Page might be empty (no sitting this day) — that's fine
    }

    await sleep(DELAY_MS);

    // Check if there's actual content
    const bodyText = await page.evaluate(() => document.body.innerText);

    // If the page just says Loading or has minimal content, skip it
    if (bodyText.length < 500 || bodyText.includes('An unhandled error')) {
      return { skipped: true, reason: 'no content' };
    }

    return { fullText: bodyText, skipped: false };

  } catch (err) {
    return { skipped: true, reason: err.message };
  }
}

// ── PROCESS SPEECHES ─────────────────────────────────────────────────────

async function processDay(debateData, meta) {
  const { fullText } = debateData;
  const { url, date, title } = meta;

  const speeches = parseSpeeches(fullText);

  const relevant = speeches
    .map(s => ({ ...s, mpName: matchMP(s.speakerRaw) }))
    .filter(s => s.mpName !== null);

  if (relevant.length === 0) return 0;

  // Build all chunks
  const allChunkRecords = [];
  for (const speech of relevant) {
    const chunks = chunkText(speech.text);
    chunks.forEach((content, i) => {
      allChunkRecords.push({
        mp_name: speech.mpName,
        debate_title: title,
        debate_date: date,
        debate_url: url,
        chunk_index: i,
        content,
        embedding: null,
      });
    });
  }

  if (allChunkRecords.length === 0) return 0;

  // Batch embed
  const batches = arrayBatch(allChunkRecords, BATCH_SIZE);
  let idx = 0;

  for (const batch of batches) {
    const embeddings = await embedBatch(batch.map(r => r.content));
    embeddings.forEach((emb, i) => {
      allChunkRecords[idx + i].embedding = emb;
    });
    idx += batch.length;
  }

  await storeChunks(allChunkRecords);
  return allChunkRecords.length;
}

// ── MAIN ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Hansard Scraper — Starting         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-NZ',
  });

  const page = await context.newPage();

  let totalChunks = 0;
  let daysProcessed = 0;
  let daysSkipped = 0;
  let daysNoSitting = 0;

  try {
    // Load checkpoint
    const scrapedUrls = await getScrapedUrls();
    console.log(`Checkpoint: ${scrapedUrls.size} days already indexed.\n`);

    // Generate all potential sitting day URLs
    const allUrls = getSittingDayUrls(DAYS_BACK);
    const toScrape = allUrls.filter(l => !scrapedUrls.has(l.url));

    console.log(`Sitting days in range: ${allUrls.length}`);
    console.log(`Already scraped:       ${allUrls.length - toScrape.length}`);
    console.log(`To scrape now:         ${toScrape.length}\n`);

    for (let i = 0; i < toScrape.length; i++) {
      const meta = toScrape[i];
      const progress = `[${i + 1}/${toScrape.length}]`;

      process.stdout.write(`${progress} ${meta.date} — `);

      const result = await scrapeDay(page, meta);

      if (result.skipped) {
        if (result.reason === 'no content') {
          process.stdout.write(`no sitting\n`);
          daysNoSitting++;
        } else {
          process.stdout.write(`error: ${result.reason}\n`);
          daysSkipped++;
        }
        await markUrlScraped(meta.url, 0, true);
        continue;
      }

      const chunksAdded = await processDay(result, meta);
      await markUrlScraped(meta.url, chunksAdded);

      totalChunks += chunksAdded;
      daysProcessed++;

      process.stdout.write(`✓ ${chunksAdded} chunks\n`);
    }

  } finally {
    await browser.close();
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  Complete                                ║`);
  console.log(`║  Days with speeches:  ${String(daysProcessed).padEnd(18)}║`);
  console.log(`║  Days no sitting:     ${String(daysNoSitting).padEnd(18)}║`);
  console.log(`║  Days errored:        ${String(daysSkipped).padEnd(18)}║`);
  console.log(`║  Total chunks:        ${String(totalChunks).padEnd(18)}║`);
  console.log('╚══════════════════════════════════════════╝\n');

  return { daysProcessed, daysSkipped, daysNoSitting, totalChunks };
}

// ── QUERY ────────────────────────────────────────────────────────────────

async function queryHansard(question, mpName = null, limit = 5) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: [question],
  });
  const embedding = res.data[0].embedding;

  const { data, error } = await supabase.rpc('match_hansard_chunks', {
    query_embedding: embedding,
    match_threshold: 0.72,
    match_count: limit,
    filter_mp: mpName || null,
  });

  if (error) {
    console.error('Query error:', error.message);
    return [];
  }

  return data;
}

module.exports = { run, queryHansard };

if (require.main === module) {
  run().catch(console.error);
}