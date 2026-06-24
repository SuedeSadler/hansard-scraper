/**
 * Hansard Scraper — hansard.parliament.nz
 *
 * Generates sitting day URLs directly from dates,
 * waits for Blazor WebAssembly to render content,
 * parses speeches by MP, batch embeds via OpenAI,
 * and stores in Supabase pgvector.
 *
 * Features:
 * - Blazor-aware page waiting (polls until content renders)
 * - Date-based URL generation — no listing page crawling
 * - Checkpoint system — restarts pick up where they left off
 * - Batched embeddings — 20 chunks per API call
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
const DAYS_BACK     = 730; // 2 years — change to 14 for weekly runs

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

function parseSpeeches(fullText) {
  const speeches = [];

  // Match Hansard format: ALL CAPS NAME (role) (time): speech text
  const speechRegex = /^([A-Z][A-Z\s\-\.\']+?)\s*\([^)]*\)\s*(?:\([0-9]{2}:[0-9]{2}\))?\s*(?:to [^:]+)?:\s*([\s\S]+?)(?=\n[A-Z][A-Z\s\-\.\']{4,}\s*\(|$)/gm;

  let match;
  while ((match = speechRegex.exec(fullText)) !== null) {
    const speakerRaw = match[1].trim();
    const text = match[2].trim().replace(/\n+/g, ' ');

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

    // Blazor WebAssembly takes time to boot and fetch data
    // Poll until the page has real content — not just the loading spinner
    try {
      await page.waitForFunction(
        () => {
          const text = document.body.innerText || '';
          return (
            text.length > 2000 &&
            !text.includes('Loading...') &&
            !text.includes('An unhandled error')
          );
        },
        { timeout: 45000, polling: 1500 }
      );
    } catch {
      // Timed out — no sitting this day or page failed to load
      return { skipped: true, reason: 'no content' };
    }

    // Small buffer after content appears to let late-rendering elements settle
    await sleep(DELAY_MS);

    const bodyText = await page.evaluate(() => document.body.innerText);

    if (!bodyText || bodyText.length < 500) {
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

  // Batch embed — 20 chunks per API call
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

  let totalChunks  = 0;
  let daysProcessed = 0;
  let daysSkipped   = 0;
  let daysNoSitting = 0;

  try {
    const scrapedUrls = await getScrapedUrls();
    console.log(`Checkpoint: ${scrapedUrls.size} days already indexed.\n`);

    const allUrls  = getSittingDayUrls(DAYS_BACK);
    const toScrape = allUrls.filter(l => !scrapedUrls.has(l.url));

    console.log(`Sitting days in range: ${allUrls.length}`);
    console.log(`Already scraped:       ${allUrls.length - toScrape.length}`);
    console.log(`To scrape now:         ${toScrape.length}\n`);

    for (let i = 0; i < toScrape.length; i++) {
      const meta     = toScrape[i];
      const progress = `[${i + 1}/${toScrape.length}]`;

      process.stdout.write(`${progress} ${meta.date} — `);

      const result = await scrapeDay(page, meta);

      if (result.skipped) {
        const reason = result.reason === 'no content' ? 'no sitting' : `error: ${result.reason}`;
        process.stdout.write(`${reason}\n`);
        result.reason === 'no content' ? daysNoSitting++ : daysSkipped++;
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