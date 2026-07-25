(() => {
  const feedEl = document.getElementById('feed');
  const loadingEl = document.getElementById('loading');
  const template = document.getElementById('post-template');
  const counterEl = document.getElementById('dev-counter-value');

  // Remember how far into the feed we've scrolled so reopening the app
  // resumes there instead of replaying the entire history from post #1.
  const RESUME_KEY = 'infiniscroll:resumeOffset';
  let offset = parseInt(localStorage.getItem(RESUME_KEY), 10) || 0;
  let isLoading = false;
  let reachedEnd = false; // set true if the server ever returns zero posts

  const timeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  function formatTimestamp(iso) {
    const then = new Date(iso).getTime();
    const diffSeconds = Math.round((then - Date.now()) / 1000);
    const abs = Math.abs(diffSeconds);

    if (abs < 60) return timeFormatter.format(diffSeconds, 'second');
    const diffMinutes = Math.round(diffSeconds / 60);
    if (Math.abs(diffMinutes) < 60) return timeFormatter.format(diffMinutes, 'minute');
    const diffHours = Math.round(diffMinutes / 60);
    if (Math.abs(diffHours) < 24) return timeFormatter.format(diffHours, 'hour');
    const diffDays = Math.round(diffHours / 24);
    return timeFormatter.format(diffDays, 'day');
  }

  function renderPost(post) {
    const node = template.content.cloneNode(true);
    node.querySelector('.post-topic').textContent = post.topic || 'misc';
    node.querySelector('.post-text').textContent = post.text;
    node.querySelector('.post-author').textContent = post.author;
    node.querySelector('.post-timestamp').textContent = formatTimestamp(post.timestamp);
    feedEl.appendChild(node);
  }

  function updateCounter(count) {
    if (typeof count === 'number') counterEl.textContent = String(count);
  }

  function showLoading(show) {
    loadingEl.classList.toggle('hidden', !show);
  }

  function showEndOfFeed() {
    const el = document.createElement('div');
    el.className = 'end-of-feed';
    el.textContent = "You're all caught up. Scroll up to revisit posts.";
    feedEl.appendChild(el);
  }

  function showErrorPost(message) {
    const el = document.createElement('section');
    el.className = 'post';
    el.innerHTML = `
      <div class="post-topic">error</div>
      <p class="post-text">Couldn't load more posts.</p>
      <div class="post-meta"><span class="post-author">${message}</span></div>
    `;
    feedEl.appendChild(el);
  }

  async function loadNextPage() {
    if (isLoading || reachedEnd) return;
    isLoading = true;
    showLoading(true);

    try {
      const res = await fetch(`/api/feed?offset=${offset}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      updateCounter(data.apiCallsThisSession);

      if (!data.posts || data.posts.length === 0) {
        reachedEnd = true;
        showEndOfFeed();
        return;
      }

      data.posts.forEach(renderPost);
      offset = data.nextOffset;
      localStorage.setItem(RESUME_KEY, String(offset));
    } catch (err) {
      console.error('Failed to load feed page:', err);
      showErrorPost(err.message);
      reachedEnd = true; // avoid hammering the API on a persistent error
    } finally {
      isLoading = false;
      showLoading(false);
    }
  }

  // Infinite scroll: fetch the next page once the user is within ~1.5 screens
  // of the bottom of what's currently rendered.
  function checkScrollPosition() {
    const { scrollTop, scrollHeight, clientHeight } = feedEl;
    const distanceToBottom = scrollHeight - (scrollTop + clientHeight);
    if (distanceToBottom < clientHeight * 1.5) {
      loadNextPage();
    }
  }

  // Coalesce scroll events to once per animation frame instead of firing on
  // every raw scroll tick — avoids competing with the browser's own snap/fling
  // physics for main-thread time, which is what causes janky, unresponsive
  // scrolling (especially noticeable scrolling back up) on lower-end phones.
  let scrollTicking = false;
  feedEl.addEventListener(
    'scroll',
    () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        checkScrollPosition();
        scrollTicking = false;
      });
    },
    { passive: true }
  );

  // Kick off the initial load.
  loadNextPage().then(() => {
    // In case the first page doesn't fill the viewport (e.g. large screens),
    // check immediately whether we already need page two.
    checkScrollPosition();
  });
})();
