# InfiniScroll

An Instagram/TikTok-style infinite scroll feed — but every "post" is short AI-generated
text (hot takes, random facts, jokes, tech takes) instead of photos. Node.js/Express
backend, vanilla HTML/CSS/JS frontend, no build step.

Heart a post (or double-tap it) to like it, or tap the X to mark it "not interested" —
both feed into a simple recommendation algorithm that biases which topics *and which
recurring accounts* show up more (or less) in future batches, entirely for free (see
below). Posts come from a fixed cast of ~30 recurring personas instead of a random
handle every time, and some posts have a couple of in-character replies. Tap the chart
icon (top-left) for your top topics, or the heart icon next to it for your liked-posts
view. Share a post via your phone's native share sheet, or it copies to your clipboard
if sharing isn't supported. Installable to your phone's home screen as a standalone app
(PWA), with haptic feedback on like/skip.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your `.env` file from the example and add your Anthropic API key:

   ```bash
   cp .env.example .env
   ```

   Then edit `.env`:

   ```
   ANTHROPIC_API_KEY=sk-ant-...your real key...
   PORT=3000
   ```

   Get a key from https://console.anthropic.com/settings/keys. **`.env` is
   gitignored — never commit your real key.**

3. Run the server:

   ```bash
   npm start              # foreground — Ctrl+C to stop
   npm run dev             # foreground, auto-restarts on file changes
   npm run start:bg        # background — doesn't need the terminal to stay open
   npm run stop            # stops whatever `start:bg` started
   npm run reset-feed      # clears data/posts.json so the feed regenerates fresh
   npm run update          # stop -> git pull -> start:bg (everyday "get latest code")
   npm run update:reset    # same, but also reset-feed first (wipes cache + all likes/skips)
   ```

   `update` is the one-liner for "pull whatever Claude just pushed and restart." It
   deliberately does **not** clear `data/posts.json` — that would silently wipe every
   post you've hearted or skipped, which feeds the recommendation algorithm. Only
   reach for `update:reset` when you specifically want a clean slate (e.g. right after
   a fix to post generation that needs old, now-stale cached posts cleared out).

   Want `npm run update` to run automatically every time you open a terminal in this
   Codespace, instead of typing it yourself? Run this **once**:

   ```bash
   bash scripts/setup-auto-update.sh
   ```

   It appends a small guarded snippet to `~/.bashrc` that runs `npm run update` the
   first time a new terminal opens (per Codespace container), then does nothing on
   any additional tabs/terminals you open after that. Safe to re-run — it detects
   the snippet is already there and skips re-adding it.

4. Open http://localhost:3000

## How the caching works (and why you won't accidentally rack up a bill)

All generated posts live in `data/posts.json`, a flat JSON array acting as a local
cache/database. This file is the source of truth the frontend actually reads from.

- **The frontend never calls the Anthropic API directly.** It only calls your own
  server (`GET /api/feed?offset=N`), which reads from `data/posts.json`.
- **A new batch is only generated when the cache runs dry.** `GET /api/feed?offset=N`
  checks whether the cache already has enough posts to serve starting at `offset`. If
  it does, it serves straight from the JSON file — **zero API calls**. If it doesn't,
  the server makes exactly **one** Anthropic API call, which generates **10 posts in
  a single request** (not 10 separate requests), appends them to `data/posts.json`,
  and then serves the page.
- **Scrolling does not equal API calls.** You can refresh the page or scroll through
  cached posts as many times as you want with no additional cost — new generation
  only happens once you scroll past everything currently cached.
- **The frontend remembers how far you've scrolled** (in `localStorage`), so
  reopening the app resumes at that offset instead of replaying the entire history
  from post #1. If that saved offset is ever ahead of what the server can serve
  (e.g. right after `npm run reset-feed`), the server falls back to serving the
  latest posts instead of an empty feed.
- **Each generation call is capped** at `max_tokens: 1000` and produces a fixed
  batch of 10 posts using `claude-haiku-4-5` (Anthropic's cheapest/fastest model),
  so a single generation call costs a small fraction of a cent. A single `/api/feed`
  request will generate at most 5 batches (50 posts) even if a stale offset asks for
  much more, so one request can't hang generating an unbounded amount.
- **Every generation call is logged to the server console** with token usage and an
  estimated dollar cost, e.g.:

  ```
  [generate-batch] +10 posts | tokens in=142 out=612 | est. cost=$0.00320 | session API calls=1 | cache size=10
  ```

  Watch this while testing to see exactly what you're spending.
- **A small dev-only counter** in the top-right corner of the UI ("API calls: N")
  shows the total number of Anthropic API calls made since the server started, so
  you can see at a glance whether scrolling is triggering new generations. It's
  gated behind no config — just delete the `#dev-counter` block in `index.html` /
  `style.css` when you no longer want it.
- `data/posts.json` is gitignored (it's a growing runtime cache, not source code) —
  delete it any time to reset the feed back to empty; the next `/api/feed` request
  will regenerate from scratch.
- **Hearting/skipping a post never calls the Anthropic API either.** It just sets a
  `reaction` field on that post in the cache. The recommendation algorithm only kicks
  in the next time a batch is generated anyway: each of the 10 post slots in a batch
  gets assigned a topic *and* an author via a weighted random draw, where a topic's
  (or author's) weight is `1 + likes - dislikes` (floored so a disliked one is heavily
  suppressed but never fully excluded). No extra API calls, no ML — just biasing a
  choice inside the generation call you were already about to make.
- **Replies cost almost nothing extra either.** A handful of the 10 post slots per
  batch are asked for 1-2 short in-character replies from other accounts in the
  roster, generated in the same API call — a few more output tokens on a call you
  were already making, not a separate request per reply.

### Recurring authors

Instead of a random throwaway handle per post, every post is written by one of ~30
fixed personas (`AUTHORS` in `server.js`), each with a short personality/voice
description and a few preferred topics. The generator picks one per post slot,
preferring an author whose preferred topics include the assigned topic, weighted by
how much you've liked/disliked that specific author before — so the accounts you
respond to keep showing up, the same way recognizing a recurring account is part of
what makes a real feed feel social.

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/feed?offset=N` | Serves 5 posts starting at index `N` from cache, generating new batches of 10 first only if needed (capped at 5 batches/request). |
| `POST` | `/api/generate-batch` | Directly triggers one generation call (10 posts), useful for manually testing generation quality/cost without the frontend. |
| `POST` | `/api/posts/:id/react` | Body `{ "reaction": "liked" \| "disliked" \| null }`. Never calls Anthropic. |
| `GET` | `/api/stats` | Returns `{ apiCallsThisSession }`. |
| `GET` | `/api/stats/topics` | Per-topic `{ topic, seen, likes, dislikes }`, sorted by net score. Powers the in-app stats view. Never calls Anthropic. |
| `GET` | `/api/liked` | All posts you've hearted, newest first. Powers the in-app favorites view. Never calls Anthropic. |

To test generation in isolation before touching the UI:

```bash
curl -X POST http://localhost:3000/api/generate-batch
```

## Project structure

```
server.js          Express server: generation, caching, feed pagination, reactions
data/posts.json    Local JSON cache/database of generated posts (gitignored)
public/
  index.html       Feed markup + post template + PWA meta tags
  style.css        Dark-mode, mobile-first, scroll-snap styling
  app.js           Infinite scroll, rendering, reactions, double-tap-to-like
  manifest.json    PWA manifest (add-to-homescreen)
  icons/           Generated app icons (see scripts/generate-icons.js)
scripts/
  generate-icons.js     Regenerate the PNG icons: `npm run icons`
  start-bg.sh           Background start with a real health check (used by `start:bg`)
  setup-auto-update.sh  One-time setup: auto-run `npm run update` on new terminals
.env.example        Template for your local .env
```
