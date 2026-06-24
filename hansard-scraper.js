/**
 * Hansard Scraper — hansard.parliament.nz
 *
 * Pure Playwright approach — loads each transcript page,
 * waits for the specific HpsByToc elements to render,
 * then extracts and parses speeches.
 *
 * Features:
 * - Waits for exact DOM elements rather than text length guessing
 * - Checkpoint system — restarts pick up where they left off
 * - Batched embeddings — 20 chunks per OpenAI call
 * - Skips non-sitting days automatically
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
const DELAY_MS      = 1500;
const DAYS_BACK     = 730; // change to 14 for weekly runs

const BASE_URL = 'https://hansard.parliament.nz';

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

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function getSittingDayDates(daysBack) {
  const dates = [];
  for (let i = 0; i <= daysBack; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayOfWeek = d.getDay();
    if (![2, 3, 4].includes(dayOfWeek)) continue;
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

// ── SCRAPE A SINGLE DAY ──────────────────────────────────────────────────

async function scrapeDay(page, date) {
  const url = `${BASE_URL}/hansard-transcript/${date}?lang=en`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait specifically for HpsByToc spans — these are the speaker elements
    // If they don't appear within 45s, there was no sitting this day
    try {
      await page.waitForSelector('[class*="HpsByToc"], .HpsByToc', {
        timeout: 45000,
      });
    } catch {
      return { skipped: true, reason: 'no content' };
    }

    // Small buffer for remaining content to render
    await sleep(DELAY_MS);

    // Extract innerHTML — we need the HTML structure for parsing
    const html = await page.evaluate(() => document.body.innerHTML);

    if (!html || html.length < 500) {
      return { skipped: true, reason: 'no content' };
    }

    return { html, skipped: false };

  } catch (err) {
    return { skipped: true, reason: err.message };
  }
}

// ── PARSE SPEECHES ───────────────────────────────────────────────────────

function parseSpeeches(html) {
  const speeches = [];

  // Target <span class="HpsByToc"> which contains speaker name + time
  // Everything after the colon until the next speaker block is the speech
  const speakerBlockRegex = /<span[^>]*class="[^"]*HpsByToc[^"]*"[^>]*>([\s\S]+?)<\/span>\s*:([\s\S]+?)(?=<a name="member"|<span[^>]*HpsByToc|<span[^>]*HpsProceedingHeading|<span[^>]*HpsSubjectHeading|$)/gi;

  let match;
  while ((match = speakerBlockRegex.exec(html)) !== null) {
    const speakerRaw = stripHtml(match[1]).trim();
    const text = stripHtml(match[2]).trim();

    if (text.split(' ').length < 25) continue;

    // Extract name — everything before the first (
    const namePart = speakerRaw.split('(')[0].trim();

    if (['SPEAKER', 'CLERK', 'CHAIRPERSON', 'ASSISTANT SPEAKER'].some(s => namePart.includes(s))) continue;

    speeches.push({ speakerRaw: namePart, text });
  }

  return speeches;
}

// ── CHECKPOINT ───────────────────────────────────────────────────────────

async function getScrapedDates() {
  const { data, error } = await supabase
    .from('hansard_scrape_log')
    .select('url');

  if (error) {
    console.log('No scrape log found — starting fresh.');
    return new Set();
  }

  return new Set((data || []).map(r => r.url));
}

async function markDateScraped(date, chunksAdded, skipped = false) {
  await supabase.from('hansard_scrape_log').upsert({
    url: date,
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

// ── PROCESS A DAY ────────────────────────────────────────────────────────

async function processDay(date, html) {
  const speeches = parseSpeeches(html);

  const relevant = speeches
    .map(s => ({ ...s, mpName: matchMP(s.speakerRaw) }))
    .filter(s => s.mpName !== null);

  if (relevant.length === 0) return 0;

  const allChunkRecords = [];

  for (const speech of relevant) {
    const chunks = chunkText(speech.text);
    chunks.forEach((content, i) => {
      allChunkRecords.push({
        mp_name: speech.mpName,
        debate_title: `Hansard ${date}`,
        debate_date: date,
        debate_url: `${BASE_URL}/hansard-transcript/${date}?lang=en`,
        chunk_index: i,
        content,
        embedding: null,
      });
    });
  }

  if (allChunkRecords.length === 0) return 0;

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

  let totalChunks   = 0;
  let daysProcessed = 0;
  let daysNoSitting = 0;
  let daysErrored   = 0;

  try {
    const scrapedDates = await getScrapedDates();
    console.log(`Checkpoint: ${scrapedDates.size} days already indexed.\n`);

    const allDates = getSittingDayDates(DAYS_BACK);
    const toScrape = allDates.filter(d => !scrapedDates.has(d));

    console.log(`Sitting days in range: ${allDates.length}`);
    console.log(`Already scraped:       ${allDates.length - toScrape.length}`);
    console.log(`To scrape now:         ${toScrape.length}\n`);

    for (let i = 0; i < toScrape.length; i++) {
      const date     = toScrape[i];
      const progress = `[${i + 1}/${toScrape.length}]`;

      process.stdout.write(`${progress} ${date} — `);

      const result = await scrapeDay(page, date);

      if (result.skipped) {
        const reason = result.reason === 'no content' ? 'no sitting' : `error: ${result.reason}`;
        process.stdout.write(`${reason}\n`);
        result.reason === 'no content' ? daysNoSitting++ : daysErrored++;
        await markDateScraped(date, 0, true);
        continue;
      }

      const chunksAdded = await processDay(date, result.html);
      await markDateScraped(date, chunksAdded);

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
  console.log(`║  Days errored:        ${String(daysErrored).padEnd(18)}║`);
  console.log(`║  Total chunks:        ${String(totalChunks).padEnd(18)}║`);
  console.log('╚══════════════════════════════════════════╝\n');

  return { daysProcessed, daysNoSitting, daysErrored, totalChunks };
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