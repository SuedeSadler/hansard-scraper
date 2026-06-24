/**
 * Hansard Scraper — parliament.nz
 * 
 * Scrapes recent Hansard debates, chunks the text,
 * generates embeddings via OpenAI, and stores in Supabase pgvector.
 * 
 * Run manually or drop into an n8n Execute Code node on a weekly schedule.
 * 
 * Setup:
 *   npm install playwright @supabase/supabase-js openai
 *   npx playwright install chromium
 */

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// ── CONFIG ──────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY   = process.env.OPENAI_KEY;

const CHUNK_SIZE   = 400;   // words per chunk
const CHUNK_OVERLAP = 50;   // word overlap between chunks
const DAYS_BACK    = 14;    // how many days of debates to scrape
const DELAY_MS     = 1200;  // polite delay between page requests

const BASE_URL = 'https://www.parliament.nz';
const SEARCH_URL = `${BASE_URL}/en/pb/hansard-debates/rhr/`;

// MPs to track — add or remove as needed
const TARGET_MPS = [
  'Christopher Luxon',
  'Nicola Willis',
  'Winston Peters',
  'David Seymour',
  'Chris Bishop',
  'Shane Jones',
  'Todd McClay',
  'Erica Stanford',
  'Mark Mitchell',
  'Chris Hipkins',
  'Carmel Sepuloni',
  'Willie Jackson',
];

// ── CLIENTS ─────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_KEY });

// ── HELPERS ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    if (chunk.trim().length > 0) chunks.push(chunk);
    i += chunkSize - overlap;
  }
  return chunks;
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function getEmbedding(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
}

// ── SUPABASE SETUP ───────────────────────────────────────────────────────
// Run this SQL once in Supabase to create the table:
//
// create extension if not exists vector;
//
// create table hansard_chunks (
//   id           bigserial primary key,
//   mp_name      text,
//   debate_title text,
//   debate_date  text,
//   debate_url   text,
//   chunk_index  int,
//   content      text,
//   embedding    vector(1536),
//   created_at   timestamptz default now()
// );
//
// create index on hansard_chunks
//   using ivfflat (embedding vector_cosine_ops)
//   with (lists = 100);

async function storeChunk({ mp_name, debate_title, debate_date, debate_url, chunk_index, content, embedding }) {
  // Check if this chunk already exists (avoid duplicates on re-runs)
  const { data: existing } = await supabase
    .from('hansard_chunks')
    .select('id')
    .eq('debate_url', debate_url)
    .eq('mp_name', mp_name)
    .eq('chunk_index', chunk_index)
    .single();

  if (existing) return; // already indexed

  const { error } = await supabase.from('hansard_chunks').insert({
    mp_name, debate_title, debate_date, debate_url, chunk_index, content, embedding
  });

  if (error) console.error('Supabase insert error:', error.message);
}

// ── SCRAPER ─────────────────────────────────────────────────────────────

async function getDebateLinks(page, fromDate) {
  console.log(`Fetching debate list from ${fromDate}...`);

  // parliament.nz search — filter by date and type
  const searchParams = new URLSearchParams({
    'Criteria.DateFrom': fromDate,
    'Criteria.page': 'HansardDebates',
    'Criteria.PageNumber': '1',
  });

  await page.goto(`${SEARCH_URL}?${searchParams}`, { waitUntil: 'networkidle' });
  await sleep(DELAY_MS);

  const links = [];
  let pageNum = 1;

  while (true) {
    // Extract debate links from current results page
    const pageLinks = await page.evaluate(() => {
      const anchors = document.querySelectorAll('.hansard__heading a, .section-block a');
      return Array.from(anchors).map(a => ({
        title: a.textContent.trim(),
        url: a.href,
      })).filter(l => l.url.includes('/hansard-debates/'));
    });

    links.push(...pageLinks);
    console.log(`  Page ${pageNum}: found ${pageLinks.length} debates`);

    // Check for next page
    const nextBtn = await page.$('a[aria-label="Next page"], .pagination__next:not([disabled])');
    if (!nextBtn) break;

    await nextBtn.click();
    await page.waitForLoadState('networkidle');
    await sleep(DELAY_MS);
    pageNum++;

    if (pageNum > 20) break; // safety cap
  }

  return links;
}

async function scrapeDebate(page, url, title) {
  console.log(`  Scraping: ${title}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await sleep(DELAY_MS);

  // Extract date from page
  const date = await page.evaluate(() => {
    const dateEl = document.querySelector('.hansard__date, time, .debate-date');
    return dateEl ? dateEl.textContent.trim() : '';
  }).catch(() => '');

  // Extract all speeches — Hansard HTML has speaker blocks
  const speeches = await page.evaluate(() => {
    const results = [];

    // parliament.nz wraps each contribution in a .Hansard or .speech block
    const blocks = document.querySelectorAll(
      '.Hansard p, .speech p, .contribution, [class*="speech"], [class*="hansard"]'
    );

    let currentSpeaker = null;
    let currentText = [];

    blocks.forEach(el => {
      const text = el.textContent.trim();
      if (!text) return;

      // Speaker names are typically in bold or a specific class
      const speakerEl = el.querySelector('b, strong, .speaker, .member-name');
      if (speakerEl) {
        // Save previous speaker's content
        if (currentSpeaker && currentText.length > 0) {
          results.push({
            speaker: currentSpeaker,
            text: currentText.join(' '),
          });
        }
        currentSpeaker = speakerEl.textContent.replace(':', '').trim();
        currentText = [text.replace(speakerEl.textContent, '').trim()];
      } else if (currentSpeaker) {
        currentText.push(text);
      }
    });

    // Push the last speaker
    if (currentSpeaker && currentText.length > 0) {
      results.push({ speaker: currentSpeaker, text: currentText.join(' ') });
    }

    return results;
  });

  return { date, speeches };
}

// ── MAIN ─────────────────────────────────────────────────────────────────

async function run() {
  console.log('Starting Hansard scrape...\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    const fromDate = dateNDaysAgo(DAYS_BACK);
    const debateLinks = await getDebateLinks(page, fromDate);

    console.log(`\nFound ${debateLinks.length} debates. Scraping speeches...\n`);

    let chunksIndexed = 0;
    let debatesProcessed = 0;

    for (const { title, url } of debateLinks) {
      try {
        const { date, speeches } = await scrapeDebate(page, url, title);

        // Only process speeches from target MPs
        const relevantSpeeches = speeches.filter(s =>
          TARGET_MPS.some(mp =>
            s.speaker.toLowerCase().includes(mp.toLowerCase().split(' ').pop()) // match by last name
          )
        );

        if (relevantSpeeches.length === 0) continue;

        for (const speech of relevantSpeeches) {
          // Match to full MP name
          const mpName = TARGET_MPS.find(mp =>
            speech.speaker.toLowerCase().includes(mp.toLowerCase().split(' ').pop())
          ) || speech.speaker;

          // Skip very short speeches (interjections etc)
          if (speech.text.split(' ').length < 30) continue;

          // Chunk the speech
          const chunks = chunkText(speech.text);

          for (let i = 0; i < chunks.length; i++) {
            const content = chunks[i];

            // Generate embedding
            const embedding = await getEmbedding(content);

            // Store in Supabase
            await storeChunk({
              mp_name: mpName,
              debate_title: title,
              debate_date: date,
              debate_url: url,
              chunk_index: i,
              content,
              embedding,
            });

            chunksIndexed++;
            process.stdout.write(`\r  ${chunksIndexed} chunks indexed...`);
          }
        }

        debatesProcessed++;

      } catch (err) {
        console.error(`\n  Error scraping ${url}:`, err.message);
      }
    }

    console.log(`\n\nDone. Processed ${debatesProcessed} debates, indexed ${chunksIndexed} chunks.`);

  } finally {
    await browser.close();
  }
}

// ── QUERY FUNCTION ───────────────────────────────────────────────────────
// Use this in your fact-checker app to retrieve relevant chunks

async function queryHansard(question, mpName = null, limit = 5) {
  const embedding = await getEmbedding(question);

  let query = supabase.rpc('match_hansard_chunks', {
    query_embedding: embedding,
    match_threshold: 0.75,
    match_count: limit,
  });

  // Optionally filter by specific MP
  if (mpName) {
    query = query.eq('mp_name', mpName);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Query error:', error.message);
    return [];
  }

  return data;
}

// SQL function to add to Supabase:
//
// create or replace function match_hansard_chunks (
//   query_embedding vector(1536),
//   match_threshold float,
//   match_count int
// )
// returns table (
//   id bigint,
//   mp_name text,
//   debate_title text,
//   debate_date text,
//   debate_url text,
//   content text,
//   similarity float
// )
// language sql stable
// as $$
//   select
//     id, mp_name, debate_title, debate_date, debate_url, content,
//     1 - (embedding <=> query_embedding) as similarity
//   from hansard_chunks
//   where 1 - (embedding <=> query_embedding) > match_threshold
//   order by similarity desc
//   limit match_count;
// $$;

module.exports = { run, queryHansard };

// Run directly: node hansard-scraper.js
if (require.main === module) {
  run().catch(console.error);
}
