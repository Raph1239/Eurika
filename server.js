require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1400; // capped per-call to control cost; higher now that replies add output
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

// A fixed roster of recurring personas instead of a fresh random handle per
// post. Real social feeds feel social because you recognize accounts —
// picking from a stable cast (and letting likes/dislikes bias which of them
// show up more) gets that for free, no extra API calls. `topics` are just a
// preference for which posts a persona tends to get assigned to; it's not
// exclusive (see pickAuthorForTopic's fallback).
const AUTHORS = [
  { handle: '@quantum_muffin', voice: 'sarcastic physicist who explains everything through baking metaphors', topics: ['science', 'tech', 'food'] },
  { handle: '@grandma_online', voice: 'wholesome grandmother thrilled to have just discovered the internet', topics: ['life-advice', 'internet-culture', 'health'] },
  { handle: '@doomer_economist', voice: 'deadpan economist who finds dark humor in every statistic', topics: ['money', 'hot-take', 'history'] },
  { handle: '@caffeinated_founder', voice: 'chronically online startup founder who calls everything a disruption', topics: ['tech', 'future-tech', 'money'] },
  { handle: '@cryptid_hunter', voice: 'earnest, wide-eyed cryptid and bigfoot enthusiast', topics: ['weird-laws', 'nature', 'geography'] },
  { handle: '@zen_but_tired', voice: 'minimalist monk persona who sounds completely exhausted', topics: ['life-advice', 'psychology', 'health'] },
  { handle: '@chaos_gremlin_gamer', voice: 'hyperactive gamer who narrates life in gaming lingo', topics: ['gaming', 'internet-culture', 'joke'] },
  { handle: '@victorian_gentleman', voice: 'overly formal 1800s aristocrat sharing trivia', topics: ['history', 'ancient-world', 'language'] },
  { handle: '@space_janitor', voice: 'deadpan janitor who insists he works at NASA', topics: ['space', 'science', 'future-tech'] },
  { handle: '@feral_raccoon', voice: 'unhinged, chaotic raccoon-brained energy', topics: ['animals', 'joke', 'hot-take'] },
  { handle: '@midnight_snacker', voice: 'food-obsessed insomniac posting at 3am', topics: ['food', 'joke', 'health'] },
  { handle: '@stat_nerd_99', voice: 'obsessed with obscure, oddly specific statistics', topics: ['random-fact', 'sports', 'geography'] },
  { handle: '@retired_pirate', voice: 'talks like a retired pirate, oddly wise', topics: ['history', 'geography', 'hot-take'] },
  { handle: '@overly_honest_therapist', voice: 'blunt therapist who overshares professional opinions', topics: ['psychology', 'life-advice', 'hot-take'] },
  { handle: '@glitch_in_the_matrix', voice: 'terminally online, speaks almost entirely in meme logic', topics: ['internet-culture', 'tech', 'joke'] },
  { handle: '@backyard_astronomer', voice: 'enthusiastic amateur stargazer with a cheap telescope', topics: ['space', 'nature', 'science'] },
  { handle: '@couch_philosopher', voice: 'delivers pseudo-deep 3am thoughts with total confidence', topics: ['hot-take', 'psychology', 'life-advice'] },
  { handle: '@linguist_lurker', voice: 'obsessed with strange word origins and etymology', topics: ['language', 'history', 'random-fact'] },
  { handle: '@future_fossil', voice: 'imagines how future archaeologists will judge us', topics: ['future-tech', 'hot-take', 'ancient-world'] },
  { handle: '@gym_bro_socrates', voice: 'fitness bro who quotes ancient philosophy unprompted', topics: ['health', 'life-advice', 'joke'] },
  { handle: '@legal_loophole_larry', voice: 'obsessed with bizarre, real-sounding obscure laws', topics: ['weird-laws', 'hot-take', 'geography'] },
  { handle: '@movie_marathon_mel', voice: 'cannot stop referencing movies for absolutely everything', topics: ['movies-and-tv', 'joke', 'internet-culture'] },
  { handle: '@broke_but_bougie', voice: 'overshares chaotic personal finance decisions with pride', topics: ['money', 'joke', 'life-advice'] },
  { handle: '@wildlife_narrator', voice: 'narrates mundane human life like a nature documentary', topics: ['animals', 'nature', 'joke'] },
  { handle: '@insomniac_scientist', voice: 'unhinged 3am lab-brain scientific tangents', topics: ['science', 'random-fact', 'tech'] },
  { handle: '@globe_trotter_ghost', voice: 'self-proclaimed world traveler with dubious claims', topics: ['geography', 'history', 'hot-take'] },
  { handle: '@retro_gamer_gran', voice: 'grandmother unexpectedly deep into retro video games', topics: ['gaming', 'internet-culture', 'life-advice'] },
  { handle: '@sports_stat_sage', voice: 'deadpan obsessive over obscure sports trivia', topics: ['sports', 'random-fact', 'hot-take'] },
  { handle: '@ancient_meme_lord', voice: 'makes memes and jokes specifically about ancient history', topics: ['ancient-world', 'history', 'joke'] },
  { handle: '@ai_skeptic_dave', voice: 'everyman deeply skeptical of AI and tech hype', topics: ['tech', 'future-tech', 'hot-take'] },
];

const AUTHOR_HANDLES = AUTHORS.map((a) => a.handle);

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    author: { type: 'string', enum: AUTHOR_HANDLES },
    text: {
      type: 'string',
      description: 'A short, in-character one-sentence reply, under 15 words.',
    },
  },
  required: ['author', 'text'],
  additionalProperties: false,
};

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
            enum: AUTHOR_HANDLES,
          },
          topic: {
            type: 'string',
            enum: TOPICS,
          },
          replies: {
            type: 'array',
            description:
              'Only include when instructed for this slot. 1-2 short in-character replies from OTHER accounts in the roster.',
            items: REPLY_SCHEMA,
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

const SYSTEM_PROMPT = `You write short posts for a fictional text-only social feed called InfiniScroll,
populated by a fixed cast of recurring accounts, each with their own personality/voice.

Each post must be 1-3 sentences, punchy, and self-contained — aim for under 30 words per post, no
exceptions. Keep it safe for a general audience. Be concise everywhere — there is a strict output token
budget.

Every post slot is assigned a specific author and a one-line voice/personality description for that
account. Write the post text fully in that account's distinct voice — not a generic post that happens to
have their name on it. Each post's "author" field must exactly equal the assigned handle, and its "topic"
field must exactly equal the assigned topic (don't force an unrelated idea into it; find a genuine angle
within it instead).

A few slots are marked for replies: for those, add a "replies" array with 1-2 short in-character reactions
from OTHER accounts in the roster (never the same account replying to itself), written in each replying
account's own distinct voice. Leave "replies" out entirely for slots not marked for it.

Variety is critical — this feed is generated in many separate batches over time, and near-duplicate
posts (same idea reworded, same joke structure, same fact from a different angle) are a hard failure.
Within a batch and across batches: never reuse an idea, fact, or joke premise you've already used; never
start two posts with the same first three words; avoid leaning on the same few crutch openers like
"Hot take:", "Fun fact:", "Did you know", or "PSA:" more than once per batch — most posts shouldn't use
a label prefix at all. Vary sentence structure and rhythm, not just topic.`;

// How many recently-generated posts to show the model so it avoids repeating
// itself. Capped so prompt size stays small as the cache grows.
const ANTI_REPEAT_WINDOW = 40;

// How many liked/disliked post texts to show the model as tone examples.
// Kept small — it's just a prompt hint, not extra API calls.
const REACTION_EXAMPLES_WINDOW = 8;

// Shared by the generation-time weighting below and the /api/stats/topics
// endpoint, so the two never drift out of sync with each other.
function getTopicCounts(cache) {
  const seen = {};
  const likes = {};
  const dislikes = {};
  for (const post of cache) {
    seen[post.topic] = (seen[post.topic] || 0) + 1;
    if (post.reaction === 'liked') likes[post.topic] = (likes[post.topic] || 0) + 1;
    if (post.reaction === 'disliked') dislikes[post.topic] = (dislikes[post.topic] || 0) + 1;
  }
  return { seen, likes, dislikes };
}

/**
 * Gives every topic a weight of 1 (baseline, keeps exploration alive even
 * for topics with no signal yet), +1 per like, -1 per dislike, floored so a
 * heavily-disliked topic is heavily suppressed but never fully excluded.
 * This is the entire "algorithm": no extra API calls, no ML, just biasing
 * which topics get assigned to the batch you were already about to generate.
 */
function computeTopicWeights(cache) {
  const { likes, dislikes } = getTopicCounts(cache);
  return TOPICS.map((topic) => Math.max(0.1, 1 + (likes[topic] || 0) - (dislikes[topic] || 0)));
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

// Same idea as getTopicCounts, but keyed by author handle -- so liking a
// specific persona's posts makes that persona show up more often too, not
// just their topics.
function getAuthorCounts(cache) {
  const likes = {};
  const dislikes = {};
  for (const post of cache) {
    if (post.reaction === 'liked') likes[post.author] = (likes[post.author] || 0) + 1;
    if (post.reaction === 'disliked') dislikes[post.author] = (dislikes[post.author] || 0) + 1;
  }
  return { likes, dislikes };
}

// Prefers an author whose declared topics include the assigned one, weighted
// by that author's own like/dislike history; falls back to the full roster
// if no author lists this topic as a preference.
function pickAuthorForTopic(topic, authorCounts) {
  const candidates = AUTHORS.filter((a) => a.topics.includes(topic));
  const pool = (candidates.length ? candidates : AUTHORS).map((author) => {
    const likes = authorCounts.likes[author.handle] || 0;
    const dislikes = authorCounts.dislikes[author.handle] || 0;
    return { author, weight: Math.max(0.1, 1 + likes - dislikes) };
  });
  const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
  let r = Math.random() * totalWeight;
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) return p.author;
  }
  return pool[pool.length - 1].author;
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
  const authorCounts = getAuthorCounts(cache);
  const batchAuthors = batchTopics.map((topic) => pickAuthorForTopic(topic, authorCounts));

  // A handful of slots get asked for a couple of in-character replies from
  // other accounts, so the feed doesn't feel like every post exists in a
  // vacuum. Not every post -- real feeds don't have comments on everything.
  const REPLY_SLOT_COUNT = Math.min(4, BATCH_SIZE);
  const replySlots = new Set();
  while (replySlots.size < REPLY_SLOT_COUNT) {
    replySlots.add(Math.floor(Math.random() * BATCH_SIZE));
  }

  const topicAssignments = batchTopics
    .map((topic, i) => {
      const author = batchAuthors[i];
      const replyNote = replySlots.has(i)
        ? ' -- include 1-2 short in-character replies from other accounts'
        : '';
      return `${i + 1}. topic: ${topic} | author: ${author.handle} (${author.voice})${replyNote}`;
    })
    .join('\n');

  const likedTexts = cache
    .filter((p) => p.reaction === 'liked')
    .slice(-REACTION_EXAMPLES_WINDOW)
    .map((p) => p.text);
  const likedBlock = likedTexts.length
    ? `\n\nThe user hearted these previous posts — lean into a similar tone/energy where it fits the ` +
      `assigned topic (but never repeat them or their wording):\n${likedTexts
        .map((t) => `- ${t}`)
        .join('\n')}`
    : '';

  const dislikedTexts = cache
    .filter((p) => p.reaction === 'disliked')
    .slice(-REACTION_EXAMPLES_WINDOW)
    .map((p) => p.text);
  const dislikedBlock = dislikedTexts.length
    ? `\n\nThe user marked these previous posts "not interested" — avoid this angle/tone, even for a ` +
      `topic that overlaps:\n${dislikedTexts.map((t) => `- ${t}`).join('\n')}`
    : '';

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          `Generate exactly ${BATCH_SIZE} new posts as a JSON object matching the schema, using this ` +
          `exact slot order (post N's "topic" and "author" fields must exactly equal the assignment ` +
          `for slot N):\n` +
          `${topicAssignments}\n\n` +
          `Every post must be a genuinely new idea, not a rewrite of anything already posted.` +
          antiRepeatBlock +
          likedBlock +
          dislikedBlock,
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
    author: String(p.author || AUTHOR_HANDLES[0]).trim(),
    topic: String(p.topic || 'misc').trim(),
    reaction: null, // 'liked' | 'disliked' | null
    replies: Array.isArray(p.replies)
      ? p.replies
          .slice(0, 3)
          .map((r) => ({ author: String(r.author || '').trim(), text: String(r.text || '').trim() }))
          .filter((r) => r.text && r.author)
      : [],
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

// Read-only view into the same counts the generator uses for weighting --
// just reads the local cache, no Anthropic calls.
app.get('/api/stats/topics', (req, res) => {
  const cache = loadCache();
  const { seen, likes, dislikes } = getTopicCounts(cache);

  const topics = TOPICS.map((topic) => ({
    topic,
    seen: seen[topic] || 0,
    likes: likes[topic] || 0,
    dislikes: dislikes[topic] || 0,
  }))
    .filter((t) => t.seen > 0)
    .sort((a, b) => (b.likes - b.dislikes) - (a.likes - a.dislikes) || b.likes - a.likes);

  res.json({ topics });
});

// This is deliberately "your liked posts," not a crowd-sourced "trending" --
// there's only one user, so there's no real popularity signal beyond your
// own reactions. Newest-created liked post first. Never calls Anthropic.
app.get('/api/liked', (req, res) => {
  const cache = loadCache();
  const posts = cache.filter((p) => p.reaction === 'liked').reverse();
  res.json({ posts });
});

// Setting a reaction never calls the Anthropic API -- it just sets a field
// on the cached post. The "algorithm" effect comes later, the next time a
// batch is generated: pickBatchTopics() / computeTopicWeights() read these
// flags to bias topic selection toward what's been liked and away from
// what's been marked not-interested.
app.post('/api/posts/:id/react', (req, res) => {
  const { id } = req.params;
  const { reaction } = req.body;

  if (reaction !== 'liked' && reaction !== 'disliked' && reaction !== null) {
    return res.status(400).json({ error: 'reaction must be "liked", "disliked", or null' });
  }

  try {
    const cache = loadCache();
    const post = cache.find((p) => p.id === id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    post.reaction = reaction;
    saveCache(cache);
    res.json({ id, reaction });
  } catch (err) {
    console.error('react error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`InfiniScroll server running at http://localhost:${PORT}`);
});
