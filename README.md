# Hansard Scraper

A Node.js scraper that pulls recent NZ parliamentary debates from parliament.nz, chunks the text, generates embeddings via OpenAI, and stores them in Supabase pgvector — ready to be queried by a RAG-powered fact-checker.

Deployed on Railway, triggered weekly by n8n cloud on a schedule.

---

## How it works

1. **Playwright** opens parliament.nz and scrapes Hansard debates from the last 14 days
2. Speeches are parsed by speaker and filtered to a list of target MPs
3. Each speech is split into ~400 word chunks with 50 word overlap
4. Each chunk is sent to OpenAI's embedding model and converted to a vector
5. The vector + metadata (MP name, debate title, date, source URL) is stored in Supabase
6. Duplicate chunks are skipped on re-runs so weekly scrapes only add new content

---

## Repo structure

```
hansard-scraper/
├── server.js          — Express server, exposes /scrape endpoint
├── hansard-scraper.js — Core scraping, chunking, and indexing logic
├── package.json
└── nixpacks.toml      — Railway build config (installs Playwright + Chromium)
```

---

## Setup

### 1. Supabase

Run this SQL once in your Supabase project to create the table and similarity search function:

```sql
create extension if not exists vector;

create table hansard_chunks (
  id           bigserial primary key,
  mp_name      text,
  debate_title text,
  debate_date  text,
  debate_url   text,
  chunk_index  int,
  content      text,
  embedding    vector(1536),
  created_at   timestamptz default now()
);

create index on hansard_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function match_hansard_chunks (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id bigint,
  mp_name text,
  debate_title text,
  debate_date text,
  debate_url text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    id, mp_name, debate_title, debate_date, debate_url, content,
    1 - (embedding <=> query_embedding) as similarity
  from hansard_chunks
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;
```

### 2. GitHub

Push all four files to a new GitHub repo called `hansard-scraper`.

### 3. Railway

- New Project → Deploy from GitHub → select `hansard-scraper`
- Railway picks up `nixpacks.toml` automatically and installs Playwright + Chromium

Add these environment variables under Variables:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_KEY` | Your Supabase service role key |
| `OPENAI_KEY` | Your OpenAI API key |
| `API_SECRET` | Any random string — used to secure the /scrape endpoint |

Railway will assign you a public URL once deployed, e.g. `hansard-scraper.up.railway.app`.

### 4. n8n

Create a two-node workflow:

**Node 1 — Schedule Trigger**
- Cron expression: `0 20 * * 5` (every Friday at 8pm)

**Node 2 — HTTP Request**
- Method: `POST`
- URL: `https://your-app.up.railway.app/scrape`
- Header: `x-api-secret` → your API_SECRET value

That's it. Every Friday night n8n triggers the scraper, new debates get indexed, Supabase stays fresh.

---

## Endpoints

### `GET /health`
Returns server status. Use this to confirm Railway deployed correctly.

```json
{ "status": "ok", "timestamp": "2026-06-20T20:00:00.000Z" }
```

### `POST /scrape`
Triggers a scrape job. Responds immediately and runs the job in the background so n8n doesn't time out.

**Required header:**
```
x-api-secret: your-secret-value
```

**Response:**
```json
{ "status": "started", "message": "Scrape job running in background" }
```

---

## Configuration

Edit the top of `hansard-scraper.js` to adjust:

| Constant | Default | What it controls |
|---|---|---|
| `CHUNK_SIZE` | 400 | Words per chunk |
| `CHUNK_OVERLAP` | 50 | Word overlap between chunks |
| `DAYS_BACK` | 14 | How far back to scrape |
| `DELAY_MS` | 1200 | Delay between page requests (be polite) |
| `TARGET_MPS` | 12 MPs | Which MPs to track |

To add or remove MPs, edit the `TARGET_MPS` array in `hansard-scraper.js`.

---

## Querying the data

In your fact-checker app, use the `queryHansard` function exported from `hansard-scraper.js`:

```js
const { queryHansard } = require('./hansard-scraper');

// Find relevant Hansard chunks for a claim
const chunks = await queryHansard(
  'Did Luxon say anything about the cost of living?',
  'Christopher Luxon', // optional — filter by MP
  5                    // number of results
);

// Each chunk returns:
// { mp_name, debate_title, debate_date, debate_url, content, similarity }
```

---

## Cost estimate

| Item | Cost |
|---|---|
| OpenAI embeddings (initial index) | ~$2–5 total |
| OpenAI embeddings (weekly re-run) | ~$0.05/week |
| Supabase (free tier) | $0 |
| Railway (free tier) | $0 |

---

## Limitations

- parliament.nz has Cloudflare bot protection — Playwright handles this but the site could update its detection at any time
- Speech parsing relies on Hansard HTML structure which can vary between debate types — selectors may need tweaking
- parliament.nz does not have a public API for Hansard at this time (their developer portal is in private beta as of mid-2026)
- Figures include all content from the target MPs — quality of parsed speeches should be spot-checked after the first run

---

Built by [Suede Sadler](https://www.linkedin.com/in/suede-sadler) · Part of the On The Record NZ fact-checker project