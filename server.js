require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1000; // capped per-call to control cost
const BATCH_SIZE = 10; // posts generated per API call
const PAGE_SIZE = 5; // posts served per feed page

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'posts.json');

// Haiku 4.5 pricing: $1.00 / $5.00 per million input/output tokens
const INPUT_COST_PER_MTOK = 1.0;
const OUTPUT_COST_PER_MTOK = 5.0;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '\n[WARN] ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n' +
      'The server will start, but /api/generate-batch and /api/feed will fail until it is set.\n'
  );
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Dev-only session counter: total Anthropic API calls made since server start.
let apiCallCount = 0;

// ---------- Cache helpers ----------

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to read cache file, starting fresh:', err.message);
    }
    return [];
  }
}

function saveCache(posts) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(posts, null, 2));
}

// ---------- Generation ----------

const POST_SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The post body: 1-3 punchy sentences.',
          },
          author: {
            type: 'string',
            description:
              'A fictional social-handle style author, e.g. "@quantum_muffin" or "@night_owl_dev".',
          },
          topic: {
            type: 'string',
            description:
              'One of: tech, random-fact, joke, hot-take, science, history, life-advice.',
          },
        },
        required: ['text', 'author', 'topic'],
        additionalProperties: false,
      },
    },
  },
  required: ['posts'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You write short posts for a fictional text-only social feed called InfiniScroll.
Each post must be 1-3 sentences, punchy, and self-contained — aim for under 30 words per post, no
exceptions. Vary topics across the batch: tech takes, random/obscure facts, one-liner jokes, hot takes,
science, history trivia, life advice. Invent a distinct, believable social-handle-style author for each
post (never a real person). Keep it safe for a general audience. Be concise everywhere — there is a
strict output token budget.

Variety is critical — this feed is generated in many separate batches over time, and near-duplicate
posts (same idea reworded, same joke structure, same fact from a different angle) are a hard failure.
Within a batch and across batches: never reuse an idea, fact, or joke premise you've already used; never
start two posts with the same first three words; avoid leaning on the same few crutch openers like
"Hot take:", "Fun fact:", "Did you know", or "PSA:" more than once per batch — most posts shouldn't use
a label prefix at all. Vary sentence structure and rhythm, not just topic.`;

// How many recently-generated posts to show the model so it avoids repeating
// itself. Capped so prompt size stays small as the cache grows.
const ANTI_REPEAT_WINDOW = 25;

/**
 * Calls the Anthropic API once to generate a batch of BATCH_SIZE posts,
 * appends them (with server-assigned id/timestamp) to the on-disk cache,
 * and returns the newly created posts.
 */
async function generateBatch() {
  const cache = loadCache();
  const recentTexts = cache.slice(-ANTI_REPEAT_WINDOW).map((p) => p.text);
  const antiRepeatBlock = recentTexts.length
    ? `\n\nAlready posted — do NOT repeat these ideas or reuse similar phrasing/structure:\n${recentTexts
        .map((t) => `- ${t}`)
        .join('\n')}`
    : '';

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          `Generate exactly ${BATCH_SIZE} new posts as a JSON object matching the schema. ` +
          `Every post must be a genuinely new idea, not a rewrite of anything already posted.` +
          antiRepeatBlock,
      },
    ],
    output_config: {
      format: {
        type: 'json_schema',
        schema: POST_SCHEMA,
      },
    },
  });

  apiCallCount += 1;

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('Anthropic response contained no text block');
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    throw new Error(`Failed to parse model output as JSON: ${err.message}`);
  }

  const rawPosts = Array.isArray(parsed.posts) ? parsed.posts : [];
  const now = Date.now();
  const newPosts = rawPosts.map((p, i) => ({
    id: crypto.randomUUID(),
    text: String(p.text || '').trim(),
    author: String(p.author || '@anonymous').trim(),
    topic: String(p.topic || 'misc').trim(),
    // Stagger timestamps slightly so posts in a batch don't share one instant.
    timestamp: new Date(now - i * 1000).toISOString(),
  }));

  const updatedCache = cache.concat(newPosts);
  saveCache(updatedCache);

  // Cost/usage logging so testing doesn't silently rack up charges.
  const { input_tokens = 0, output_tokens = 0 } = response.usage || {};
  const cost =
    (input_tokens / 1_000_000) * INPUT_COST_PER_MTOK +
    (output_tokens / 1_000_000) * OUTPUT_COST_PER_MTOK;
  console.log(
    `[generate-batch] +${newPosts.length} posts | ` +
      `tokens in=${input_tokens} out=${output_tokens} | ` +
      `est. cost=$${cost.toFixed(5)} | ` +
      `session API calls=${apiCallCount} | cache size=${updatedCache.length}`
  );

  return newPosts;
}

// ---------- Routes ----------

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/generate-batch', async (req, res) => {
  try {
    const posts = await generateBatch();
    res.json({ posts, apiCallsThisSession: apiCallCount });
  } catch (err) {
    console.error('generate-batch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/feed', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const neededCount = page * PAGE_SIZE;

  try {
    let cache = loadCache();

    // Only generate when the cache can't satisfy this page yet, and only
    // BATCH_SIZE at a time (never per-scroll, never one-off).
    while (cache.length < neededCount) {
      await generateBatch();
      cache = loadCache();
    }

    const start = (page - 1) * PAGE_SIZE;
    const posts = cache.slice(start, start + PAGE_SIZE);

    res.json({
      posts,
      page,
      pageSize: PAGE_SIZE,
      totalCached: cache.length,
      apiCallsThisSession: apiCallCount,
    });
  } catch (err) {
    console.error('feed error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  res.json({ apiCallsThisSession: apiCallCount });
});

app.listen(PORT, () => {
  console.log(`InfiniScroll server running at http://localhost:${PORT}`);
});
