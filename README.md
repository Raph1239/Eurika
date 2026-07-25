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
   npm start
   # or, for auto-restart on file changes:
   npm run dev
   ```

4. Open http://localhost:3000

## How the caching works (and why you won't accidentally rack up a bill)

All generated posts live in `data/posts.json`, a flat JSON array acting as a local
cache/database. This file is the source of truth the frontend actually reads from.

- **The frontend never calls the Anthropic API directly.** It only calls your own
  server (`GET /api/feed?page=N`), which reads from `data/posts.json`.
- **A new batch is only generated when the cache runs dry.** `GET /api/feed?page=N`
  checks whether the cache already has enough posts to serve that page. If it does,
  it serves straight from the JSON file — **zero API calls**. If it doesn't, the
  server makes exactly **one** Anthropic API call, which generates **10 posts in a
  single request** (not 10 separate requests), appends them to `data/posts.json`,
  and then serves the page.
- **Scrolling does not equal API calls.** You can refresh the page or scroll through
  cached posts as many times as you want with no additional cost — new generation
  only happens once you scroll past everything currently cached.
- **Each generation call is capped** at `max_tokens: 900` and produces a fixed batch
  of 10 posts using `claude-haiku-4-5` (Anthropic's cheapest/fastest model), so a
  single generation call costs a small fraction of a cent.
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
| `GET` | `/api/feed?page=N` | Serves 5 posts for page `N` from cache, generating a new batch of 10 first only if needed. |
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
