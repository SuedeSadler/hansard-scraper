/**
 * Hansard Scraper — hansard.parliament.nz
 *
 * Uses Playwright to pass Radware bot protection,
 * extracts session cookies, then uses those cookies
 * for direct API calls to fetch transcripts efficiently.
 *
 * Flow:
 * 1. Playwright loads one page to get Radware cookies
 * 2. Cookies passed to fetch() for all subsequent API calls
 * 3. No browser needed per page — just one warm-up load
 *
 * Features:
 * - Single browser session for cookie extraction
 * - Direct API calls after cookie handshake
 * - Checkpoint system — restarts pick up where they left off
 * - Batched embeddings — 20 chunks per OpenAI call
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
const DELAY_MS      = 800;
const DAYS_BACK     = 730; // change to 14 for weekly runs

const API_BASE    = 'https://hansard.parliament.nz/api/resources/transcript';
const WARMUP_URL  = 'https://hansard.parliament.nz/hansard-transcript/2026-06-24?lang=en';

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

// ── COOKIE EXTRACTION ────────────────────────────────────────────────────
// Load one real page with Playwright to pass Radware bot check
// Extract all cookies and return as a header string for fetch()

async function getSessionCookies() {
  console.log('Launching browser to pass bot protection...');

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

  try {
    // Load a real page so Radware sets its cookies
    await page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for Radware challenge to complete — it sets cookies then redirects
    await page.waitForFunction(
      () => {
        const text = document.body.innerText || '';
        return text.length > 500 && !text.includes('Verifying') && !text.includes('Radware');
      },
      { timeout: 30000, polling: 1000 }
    ).catch(() => {
      console.log('Radware wait timed out — proceeding with whatever cookies we have');
    });

    await sleep(2000);

    // Extract all cookies from the browser context
    const cookies = await context.cookies();
    const cookieHeader = cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    console.log(`Got ${cookies.length} cookies from browser session.\n`);

    // Also grab the user agent for consistency
    const userAgent = await page.evaluate(() => navigator.userAgent);

    return { cookieHeader, userAgent };

  } finally {
    await browser.close();
  }
}

// ── FETCH TRANSCRIPT ─────────────────────────────────────────────────────

async function fetchTranscript(date, cookieHeader, userAgent) {
  const url = `${API_BASE}/${date}`;

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json, text/html, */*',
      'Accept-Language': 'en-NZ,en;q=0.9',
      'Referer': `https://hansard.parliament.nz/hansard-transcript/${date}?lang=en`,
      'Origin': 'https://hansard.parliament.nz',
      'User-Agent': userAgent,
      'Cookie': cookieHeader,
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'sec-ch-ua-mobile': '?0',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
  });

  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();

  // Check if we got blocked again
  if (text.includes('Radware') || text.includes('Verifying') || text.length < 200) {
    throw new Error('Bot protection triggered — cookies may have expired');
  }

  // API returns a JSON-encoded HTML string
  let html = text;
  if (text.trim().startsWith('"')) {
    html = JSON.parse(text);
  }

  return html;
}

// ── PARSE SPEECHES ───────────────────────────────────────────────────────

function parseSpeeches(html) {
  const speeches = [];

  // Speaker names are in <span class="HpsByToc"> tags
  // Format: SPEAKER NAME (Role) (HH:MM)
  const speakerBlockRegex = /<span class="HpsByToc"[^>]*>([\s\S]+?)<\/span>\s*:([\s\S]+?)(?=<a name="member"|<span class="HpsByToc"|<span class="HpsProceedingHeading"|<span class="HpsSubjectHeading"|$)/gi;

  let match;
  while ((match = speakerBlockRegex.exec(html)) !== null) {
    const speakerRaw = stripHtml(match[1]).trim();
    const text = stripHtml(match[2]).trim();

    if (text.split(' ').length < 25) continue;

    // Extract name before first bracket
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
        debate_url: `https://hansard.parliament.nz/hansard-transcript/${date}?lang=en`,
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

  let totalChunks   = 0;
  let daysProcessed = 0;
  let daysNoSitting = 0;
  let daysErrored   = 0;

  // Step 1 — get session cookies via Playwright
  const { cookieHeader, userAgent } = await getSessionCookies();

  // Step 2 — load checkpoint
  const scrapedDates = await getScrapedDates();
  console.log(`Checkpoint: ${scrapedDates.size} days already indexed.\n`);

  const allDates = getSittingDayDates(DAYS_BACK);
  const toScrape = allDates.filter(d => !scrapedDates.has(d));

  console.log(`Sitting days in range: ${allDates.length}`);
  console.log(`Already scraped:       ${allDates.length - toScrape.length}`);
  console.log(`To scrape now:         ${toScrape.length}\n`);

  // Step 3 — fetch and process each day via API
  for (let i = 0; i < toScrape.length; i++) {
    const date     = toScrape[i];
    const progress = `[${i + 1}/${toScrape.length}]`;

    process.stdout.write(`${progress} ${date} — `);

    try {
      await sleep(DELAY_MS);

      const html = await fetchTranscript(date, cookieHeader, userAgent);

      if (!html) {
        process.stdout.write(`no sitting\n`);
        daysNoSitting++;
        await markDateScraped(date, 0, true);
        continue;
      }

      const chunksAdded = await processDay(date, html);
      await markDateScraped(date, chunksAdded);

      totalChunks += chunksAdded;
      daysProcessed++;

      process.stdout.write(`✓ ${chunksAdded} chunks\n`);

    } catch (err) {
      // If bot protection triggers mid-run, refresh cookies and retry once
      if (err.message.includes('Bot protection')) {
        console.log('\nBot protection triggered — refreshing cookies...');
        try {
          const fresh = await getSessionCookies();
          Object.assign({ cookieHeader, userAgent }, fresh);
          i--; // retry this date
        } catch (refreshErr) {
          process.stdout.write(`cookie refresh failed: ${refreshErr.message}\n`);
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