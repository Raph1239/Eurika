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
const MAX_BATCHES_PER_REQUEST = 5; // safety cap, see /api/feed

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

// A deliberately large pool so each batch can be assigned distinct topics —
// relying on the model to self-diversify (via prompt instructions alone)
// wasn't enough on a small/cheap model like Haiku, which tends to converge
// on the same few ideas per category. Forcing one topic per post slot is a
// hard structural constraint instead of a soft suggestion.
const TOPICS = [
  'tech',
  'random-fact',
  'joke',
  'hot-take',
  'science',
  'history',
  'life-advice',
  'space',
  'nature',
  'food',
  'internet-culture',
  'psychology',
  'money',
  'language',
  'ancient-world',
  'weird-laws',
  'sports',
  'movies-and-tv',
  'future-tech',
  'health',
  'animals',
  'geography',
  'gaming',
];

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
            enum: TOPICS,
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
exceptions. Invent a distinct, believable social-handle-style author for each post (never a real
person). Keep it safe for a general audience. Be concise everywhere — there is a strict output token
budget.

Variety is critical — this feed is generated in many separate batches over time, and near-duplicate
posts (same idea reworded, same joke structure, same fact from a different angle) are a hard failure.
Within a batch and across batches: never reuse an idea, fact, or joke premise you've already used; never
start two posts with the same first three words; avoid leaning on the same few crutch openers like
"Hot take:", "Fun fact:", "Did you know", or "PSA:" more than once per batch — most posts shouldn't use
a label prefix at all. Vary sentence structure and rhythm, not just topic. Each post's "topic" field must
match its actual content — don't force an unrelated idea into an assigned topic; find a genuine angle
within it instead.`;

// How many recently-generated posts to show the model so it avoids repeating
// itself. Capped so prompt size stays small as the cache grows.
const ANTI_REPEAT_WINDOW = 40;

// How many liked post texts to show the model as style/tone examples. Kept
// small — it's just a prompt hint, not extra API calls.
const LIKED_EXAMPLES_WINDOW = 8;

/**
 * Gives every topic a weight of 1 (baseline, keeps exploration alive for
 * topics never liked yet) plus one extra point per like it's ever received.
 * This is the entire "algorithm": no extra API calls, no ML, just biasing
 * which topics get assigned to the batch you were already about to generate.
 */
function computeTopicWeights(cache) {
  const likeCounts = {};
  for (const post of cache) {
    if (post.liked) likeCounts[post.topic] = (likeCounts[post.topic] || 0) + 1;
  }
  return TOPICS.map((topic) => 1 + (likeCounts[topic] || 0));
}

// Weighted random permutation (roulette-wheel selection without
// replacement) — topics with more likes tend to sort earlier, but every
// topic still appears somewhere so the feed never collapses onto just one
// or two liked categories.
function weightedTopicOrder(weights) {
  const pool = TOPICS.map((topic, i) => ({ topic, weight: weights[i] }));
  const order = [];
  while (pool.length > 0) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    let r = Math.random() * totalWeight;
    let idx = 0;
    while (idx < pool.length - 1 && r > pool[idx].weight) {
      r -= pool[idx].weight;
      idx += 1;
    }
    order.push(pool.splice(idx, 1)[0].topic);
  }
  return order;
}

function pickBatchTopics(cache) {
  const shuffled = weightedTopicOrder(computeTopicWeights(cache));
  // If BATCH_SIZE ever exceeds the topic pool size, wrap around rather than
  // running out of entries.
  return Array.from({ length: BATCH_SIZE }, (_, i) => shuffled[i % shuffled.length]);
}

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

  const batchTopics = pickBatchTopics(cache);
  const topicAssignments = batchTopics
    .map((topic, i) => `${i + 1}. ${topic}`)
    .join('\n');

  const likedTexts = cache
    .filter((p) => p.liked)
    .slice(-LIKED_EXAMPLES_WINDOW)
    .map((p) => p.text);
  const likedBlock = likedTexts.length
    ? `\n\nThe user hearted these previous posts — lean into a similar tone/energy where it fits the ` +
      `assigned topic (but never repeat them or their wording):\n${likedTexts
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
          `Generate exactly ${BATCH_SIZE} new posts as a JSON object matching the schema, in this ` +
          `exact topic order (post N's "topic" field must equal the assigned topic for slot N):\n` +
          `${topicAssignments}\n\n` +
          `Every post must be a genuinely new idea, not a rewrite of anything already posted.` +
          antiRepeatBlock +
          likedBlock,
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
    liked: false,
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
// Disable caching on the frontend assets. This is a fast-moving dev project —
// the API contract between app.js and this server has already changed once,
// and a stale cached app.js talking to a freshly-updated server (or vice
// versa) silently breaks in confusing ways (e.g. the feed appearing stuck on
// the same 5 posts). Not worth trading that confusion for the tiny perf win
// of caching a few KB of static files.
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-store'),
  })
);

// Belt-and-suspenders: API responses shouldn't be cached either.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

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
  // The client tracks how many posts it has already shown (persisted in
  // localStorage) and asks for the next PAGE_SIZE starting at that offset —
  // this is what lets reopening the app resume where you left off instead
  // of replaying the entire history from post #1 every time.
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const neededCount = offset + PAGE_SIZE;

  try {
    let cache = loadCache();

    // Generate in batches until the cache can satisfy this offset, but cap
    // how many batches a single request will generate. Without this cap, a
    // stale offset (e.g. left over in localStorage from before `npm run
    // reset-feed`) could force dozens of sequential Anthropic calls inside
    // one HTTP request and hang for minutes.
    let batchesThisRequest = 0;
    while (cache.length < neededCount && batchesThisRequest < MAX_BATCHES_PER_REQUEST) {
      await generateBatch();
      cache = loadCache();
      batchesThisRequest += 1;
    }

    let posts = cache.slice(offset, offset + PAGE_SIZE);
    let effectiveOffset = offset;

    // The requested offset is beyond anything we could generate (almost
    // always a stale/invalid resume pointer) -- fall back to the latest
    // posts instead of returning nothing.
    if (posts.length === 0 && cache.length > 0) {
      effectiveOffset = Math.max(0, cache.length - PAGE_SIZE);
      posts = cache.slice(effectiveOffset);
    }

    res.json({
      posts,
      offset: effectiveOffset,
      nextOffset: effectiveOffset + posts.length,
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

// Toggling a like never calls the Anthropic API -- it just flips a flag on
// the cached post. The "algorithm" effect comes later, the next time a
// batch is generated: pickBatchTopics() reads these flags to bias topic
// selection toward whatever the user has been hearting.
app.post('/api/posts/:id/like', (req, res) => {
  const { id } = req.params;
  const liked = !!req.body.liked;

  try {
    const cache = loadCache();
    const post = cache.find((p) => p.id === id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    post.liked = liked;
    saveCache(cache);
    res.json({ id, liked });
  } catch (err) {
    console.error('like error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`InfiniScroll server running at http://localhost:${PORT}`);
});
