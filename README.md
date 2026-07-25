# InfiniScroll

An Instagram/TikTok-style infinite scroll feed — but every "post" is short AI-generated
text (hot takes, random facts, jokes, tech takes) instead of photos. Node.js/Express
backend, vanilla HTML/CSS/JS frontend, no build step.

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
   ```

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

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/feed?offset=N` | Serves 5 posts starting at index `N` from cache, generating new batches of 10 first only if needed (capped at 5 batches/request). |
| `POST` | `/api/generate-batch` | Directly triggers one generation call (10 posts), useful for manually testing generation quality/cost without the frontend. |
| `GET` | `/api/stats` | Returns `{ apiCallsThisSession }`. |

To test generation in isolation before touching the UI:

```bash
curl -X POST http://localhost:3000/api/generate-batch
```

## Project structure

```
server.js          Express server: generation, caching, feed pagination
data/posts.json    Local JSON cache/database of generated posts (gitignored)
public/
  index.html       Feed markup + post template
  style.css        Dark-mode, mobile-first, scroll-snap styling
  app.js           Infinite scroll + rendering + dev API-call counter
.env.example        Template for your local .env
```
