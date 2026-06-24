/**
 * Hansard Scraper — parliament.nz
 * 
 * Scrapes NZ parliamentary debates, chunks speeches by MP,
 * generates batched embeddings via OpenAI, and stores in Supabase pgvector.
 * 
 * Features:
 * - Checkpoint system: saves progress so restarts pick up where they left off
 * - Batched embeddings: 20 chunks per API call instead of 1 (5x faster)
 * - Regex-based speech parser: works on plain text, no DOM complexity
 * - Polite delays between requests
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

const CHUNK_SIZE     = 400;   // words per chunk
const CHUNK_OVERLAP  = 50;    // word overlap between chunks
const BATCH_SIZE     = 20;    // chunks per OpenAI embedding call
const DELAY_MS       = 1200;  // ms between page requests (be polite)
const DAYS_BACK      = 730;   // 2 years — change to 14 for weekly runs

const BASE_URL    = 'https://www.parliament.nz';
const LISTING_URL = `${BASE_URL}/en/pb/hansard-debates/rhr/`;

// MPs to track — add or remove as needed
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

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function arrayBatch(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

// Normalise MP names — handle titles like "Hon", "Rt Hon", "Dr"
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
    // Match on last name at minimum, full name preferred
    const mpParts = mp.split(' ');
    const lastName = mpParts[mpParts.length - 1];
    return normalised.includes(lastName) || normalised === mp;
  }) || null;
}

// ── SPEECH PARSER ────────────────────────────────────────────────────────
// Handles the exact Hansard format:
// SPEAKER NAME (Role/Party—Electorate) (HH:MM): Speech text...

function parseSpeeches(fullText) {
  const speeches = [];

  // Regex: ALL CAPS NAME (optional stuff) (optional time): content
  // Stops at next speaker block or end of text
  const speechRegex = /^([A-Z][A-Z\s\-\.\']+?)\s*\([^)]*\)\s*(?:\([0-9]{2}:[0-9]{2}\))?\s*(?:to [^:]+)?:\s*([\s\S]+?)(?=\n[A-Z][A-Z\s\-\.\']{4,}\s*\(|$)/gm;

  let match;
  while ((match = speechRegex.exec(fullText)) !== null) {
    const speakerRaw = match[1].trim();
    const text = match[2].trim().replace(/\n+/g, ' ');

    // Skip very short content — interjections, procedural one-liners
    if (text.split(' ').length < 25) continue;

    // Skip procedural speakers
    if (['SPEAKER', 'CLERK', 'CHAIRPERSON', 'ASSISTANT SPEAKER'].some(s => speakerRaw.includes(s))) continue;

    speeches.push({ speakerRaw, text });
  }

  return speeches;
}

// ── CHECKPOINT SYSTEM ────────────────────────────────────────────────────
// Stores scraped URL list in Supabase so restarts skip already-done pages

async function getScrapedUrls() {
  const { data, error } = await supabase
    .from('hansard_scrape_log')
    .select('url');

  if (error) {
    // Table might not exist yet — that's fine on first run
    console.log('Scrape log not found, starting fresh.');
    return new Set();
  }

  return new Set((data || []).map(r => r.url));
}

async function markUrlScraped(url, chunksAdded) {
  await supabase.from('hansard_scrape_log').upsert({
    url,
    chunks_added: chunksAdded,
    scraped_at: new Date().toISOString(),
  }, { onConflict: 'url' });
}

// ── EMBEDDINGS (BATCHED) ─────────────────────────────────────────────────

async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return res.data.map(d => d.embedding);
}

// ── SUPABASE STORAGE ─────────────────────────────────────────────────────

async function storeChunks(chunks) {
  if (chunks.length === 0) return;

  const { error } = await supabase.from('hansard_chunks').insert(chunks);
  if (error) console.error('  Supabase insert error:', error.message);
}

// ── SCRAPER ──────────────────────────────────────────────────────────────

async function getDebateLinks(page, fromDate) {
  console.log(`\nFetching debate listing from ${fromDate}...\n`);

  const links = [];
  let pageNum = 1;

  // parliament.nz listing — paginate through results
  while (true) {
    const url = `${LISTING_URL}?Criteria.DateFrom=${fromDate}&Criteria.PageNumber=${pageNum}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    await sleep(DELAY_MS);

    const pageLinks = await page.evaluate((baseUrl) => {
      const results = [];
      // Find all table rows or listing items
      const rows = document.querySelectorAll('tr, .listing-item, .hansard-item');

      rows.forEach(row => {
        const text = row.textContent || '';
        // Only grab Daily transcripts — these have full day content
        if (!text.includes('Daily')) return;

        const anchor = row.querySelector('a[href*="hansard"]');
        if (!anchor) return;

        const href = anchor.getAttribute('href');
        const fullUrl = href.startsWith('http') ? href : baseUrl + href;
        const dateCell = row.querySelector('td:first-child');

        results.push({
          url: fullUrl,
          date: dateCell ? dateCell.textContent.trim() : '',
          title: anchor.textContent.trim() || 'Daily Transcript',
        });
      });

      return results;
    }, BASE_URL);

    if (pageLinks.length === 0) break;
    links.push(...pageLinks);
    console.log(`  Listing page ${pageNum}: ${pageLinks.length} debates found`);

    // Check for next page button
    const hasNext = await page.$('a[aria-label="Next page"], .pagination__next:not([disabled]), a.next');
    if (!hasNext) break;

    await hasNext.click();
    await page.waitForLoadState('networkidle');
    await sleep(DELAY_MS);
    pageNum++;

    if (pageNum > 200) break; // safety cap — 2 years is ~180 pages
  }

  return links;
}

async function scrapeDebatePage(page, { url, date, title }) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await sleep(DELAY_MS);

  // Grab full plain text — Hansard is clean enough to parse as text
  const fullText = await page.evaluate(() => document.body.innerText);

  return { fullText, date, title, url };
}

// ── PROCESS A SINGLE DEBATE ──────────────────────────────────────────────

async function processDebate(debateData) {
  const { fullText, date, title, url } = debateData;
  const speeches = parseSpeeches(fullText);

  // Filter to target MPs only
  const relevant = speeches
    .map(s => ({ ...s, mpName: matchMP(s.speakerRaw) }))
    .filter(s => s.mpName !== null);

  if (relevant.length === 0) return 0;

  // Build all chunks first, then batch embed
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
        embedding: null, // filled in below
      });
    });
  }

  if (allChunkRecords.length === 0) return 0;

  // Batch embed — 20 chunks per API call
  const batches = arrayBatch(allChunkRecords, BATCH_SIZE);
  let embedIdx = 0;

  for (const batch of batches) {
    const texts = batch.map(r => r.content);
    const embeddings = await embedBatch(texts);
    embeddings.forEach((emb, i) => {
      allChunkRecords[embedIdx + i].embedding = emb;
    });
    embedIdx += batch.length;
  }

  // Store all chunks for this debate
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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  let totalChunks = 0;
  let debatesProcessed = 0;
  let debatesSkipped = 0;

  try {
    // Load checkpoint — which URLs have we already scraped?
    const scrapedUrls = await getScrapedUrls();
    console.log(`Checkpoint: ${scrapedUrls.size} debates already indexed, skipping those.\n`);

    // Get all debate links within range
    const fromDate = dateNDaysAgo(DAYS_BACK);
    const allLinks = await getDebateLinks(page, fromDate);

    // Filter out already-scraped URLs
    const toScrape = allLinks.filter(l => !scrapedUrls.has(l.url));
    console.log(`\nTotal debates found: ${allLinks.length}`);
    console.log(`Already scraped:     ${allLinks.length - toScrape.length}`);
    console.log(`To scrape now:       ${toScrape.length}\n`);

    for (let i = 0; i < toScrape.length; i++) {
      const link = toScrape[i];
      const progress = `[${i + 1}/${toScrape.length}]`;

      try {
        process.stdout.write(`${progress} ${link.date} — scraping...`);

        const debateData = await scrapeDebatePage(page, link);
        const chunksAdded = await processDebate(debateData);

        // Mark as done in checkpoint table
        await markUrlScraped(link.url, chunksAdded);

        totalChunks += chunksAdded;
        debatesProcessed++;

        process.stdout.write(` ✓ ${chunksAdded} chunks\n`);

      } catch (err) {
        process.stdout.write(` ✗ ${err.message}\n`);
        debatesSkipped++;
      }
    }

  } finally {
    await browser.close();
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  Done.                                   ║`);
  console.log(`║  Debates processed: ${String(debatesProcessed).padEnd(20)}║`);
  console.log(`║  Debates skipped:   ${String(debatesSkipped).padEnd(20)}║`);
  console.log(`║  Chunks indexed:    ${String(totalChunks).padEnd(20)}║`);
  console.log('╚══════════════════════════════════════════╝\n');

  return { debatesProcessed, debatesSkipped, totalChunks };
}

// ── QUERY FUNCTION ───────────────────────────────────────────────────────
// Use this in your fact-checker to retrieve relevant Hansard chunks

async function queryHansard(question, mpName = null, limit = 5) {
  // Embed the question
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: [question],
  });
  const embedding = res.data[0].embedding;

  // Similarity search in Supabase
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