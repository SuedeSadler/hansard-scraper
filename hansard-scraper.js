/**
 * Hansard Scraper — hansard.parliament.nz
 *
 * Accepts session headers (including uzlc token) passed from
 * grab-token.js running on a local machine, then uses those
 * headers to call the transcript API directly from Railway.
 */

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const OPENAI_KEY    = process.env.OPENAI_KEY;

const CHUNK_SIZE    = 400;
const CHUNK_OVERLAP = 50;
const BATCH_SIZE    = 20;
const DELAY_MS      = 1000;
const DAYS_BACK     = 730;

const BASE_URL = 'https://hansard.parliament.nz';
const API_BASE = `${BASE_URL}/api/resources/transcript`;

const TARGET_MPS = [
  'CHRISTOPHER LUXON', 'NICOLA WILLIS', 'WINSTON PETERS',
  'DAVID SEYMOUR', 'CHRIS BISHOP', 'SHANE JONES',
  'TODD MCCLAY', 'ERICA STANFORD', 'MARK MITCHELL',
  'CHRIS HIPKINS', 'CARMEL SEPULONI', 'WILLIE JACKSON',
  'SIMEON BROWN', 'JUDITH COLLINS', 'LOUISE UPSTON',
  'MATT DOOCEY', 'TAMA POTAKA', 'PAUL GOLDSMITH',
  'SHANE RETI', 'CASEY COSTELLO',
];

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_KEY });

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

async function fetchTranscript(date, sessionHeaders) {
  const url = `${API_BASE}/${date}`;
  const res = await fetch(url, {
    headers: {
      ...sessionHeaders,
      'referer': `${BASE_URL}/hansard-transcript/${date}?lang=en`,
    },
  });

  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  if (text.includes('Radware') || text.includes('uzdbm') || text.length < 200) {
    throw new Error('bot_protection');
  }

  let html = text;
  if (text.trim().startsWith('"')) html = JSON.parse(text);
  return html;
}

function parseSpeeches(html) {
  const speeches = [];
  const re = /<span[^>]*class="[^"]*HpsByToc[^"]*"[^>]*>([\s\S]+?)<\/span>\s*:([\s\S]+?)(?=<a name="member"|<span[^>]*HpsByToc|<span[^>]*HpsProceedingHeading|<span[^>]*HpsSubjectHeading|$)/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const speakerRaw = stripHtml(match[1]).trim();
    const text = stripHtml(match[2]).trim();
    if (text.split(' ').length < 25) continue;
    const namePart = speakerRaw.split('(')[0].trim();
    if (['SPEAKER', 'CLERK', 'CHAIRPERSON', 'ASSISTANT SPEAKER'].some(s => namePart.includes(s))) continue;
    speeches.push({ speakerRaw: namePart, text });
  }
  return speeches;
}

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
        mp_name: speech.mpName, debate_title: `Hansard ${date}`,
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

async function runWithHeaders(sessionHeaders) {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Hansard Scraper — Starting         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  let totalChunks = 0, daysProcessed = 0, daysNoSitting = 0, daysErrored = 0;

  const scrapedDates = await getScrapedDates();
  console.log(`Checkpoint: ${scrapedDates.size} days already indexed.\n`);

  const allDates = getSittingDayDates(DAYS_BACK);
  const toScrape = allDates.filter(d => !scrapedDates.has(d));

  console.log(`Sitting days in range: ${allDates.length}`);
  console.log(`Already scraped:       ${allDates.length - toScrape.length}`);
  console.log(`To scrape now:         ${toScrape.length}\n`);

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

    } catch (err) {
      if (err.message === 'bot_protection') {
        process.stdout.write('token expired — re-run grab-token.js\n');
        console.log('\nuzlc token has expired. Run grab-token.js on your Mac again to resume.');
        break; // stop — token is dead, no point continuing
      }
      process.stdout.write(`error: ${err.message}\n`);
      daysErrored++;
    }
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log(`║  Complete                                ║`);
  console.log(`║  Days with speeches:  ${String(daysProcessed).padEnd(18)}║`);
  console.log(`║  Days no sitting:     ${String(daysNoSitting).padEnd(18)}║`);
  console.log(`║  Days errored:        ${String(daysErrored).padEnd(18)}║`);
  console.log(`║  Total chunks:        ${String(totalChunks).padEnd(18)}║`);
  console.log('╚══════════════════════════════════════════╝\n');
}

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

module.exports = { runWithHeaders, queryHansard };