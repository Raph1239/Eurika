(() => {
  const feedEl = document.getElementById('feed');
  const loadingEl = document.getElementById('loading');
  const template = document.getElementById('post-template');
  const counterEl = document.getElementById('dev-counter-value');
  const statsBtn = document.getElementById('stats-btn');
  const statsOverlay = document.getElementById('stats-overlay');
  const statsClose = document.getElementById('stats-close');
  const statsBody = document.getElementById('stats-body');
  const favoritesBtn = document.getElementById('favorites-btn');
  const favoritesFeedEl = document.getElementById('favorites-feed');

  // Deterministic color per string (no shared list with the server needed —
  // the same string always hashes to the same hue), reused for the topic
  // badge, author avatars, reply author names, and the stats view bars.
  function hashStringToHue(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash % 360;
  }

  function hashTextColor(str) {
    return `hsl(${hashStringToHue(str)}, 70%, 72%)`;
  }

  function hashBgColor(str) {
    return `hsla(${hashStringToHue(str)}, 70%, 55%, 0.16)`;
  }

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toast.addEventListener('animationend', () => toast.remove());
    document.body.appendChild(toast);
  }

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

  function renderAvatar(avatarEl, author) {
    const initial = (author || '?').replace('@', '').charAt(0).toUpperCase();
    avatarEl.textContent = initial;
    avatarEl.style.background = hashBgColor(author);
    avatarEl.style.color = hashTextColor(author);
  }

  function renderReplies(container, replies) {
    container.innerHTML = ''; // safe: only ever holds nodes we build below
    if (!Array.isArray(replies) || replies.length === 0) return;
    replies.slice(0, 2).forEach((reply) => {
      const row = document.createElement('div');
      row.className = 'reply-row';
      const authorSpan = document.createElement('span');
      authorSpan.className = 'reply-author';
      authorSpan.textContent = reply.author;
      authorSpan.style.color = hashTextColor(reply.author);
      row.appendChild(authorSpan);
      row.appendChild(document.createTextNode(reply.text));
      container.appendChild(row);
    });
  }

  function renderPost(post, container) {
    const node = template.content.cloneNode(true);
    const postEl = node.querySelector('.post');
    const topicEl = node.querySelector('.post-topic');
    const topic = post.topic || 'misc';
    topicEl.textContent = topic;
    topicEl.style.color = hashTextColor(topic);
    topicEl.style.background = hashBgColor(topic);
    node.querySelector('.post-text').textContent = post.text;
    renderAvatar(node.querySelector('.post-avatar'), post.author);
    node.querySelector('.post-author').textContent = post.author;
    node.querySelector('.post-timestamp').textContent = formatTimestamp(post.timestamp);
    renderReplies(node.querySelector('.post-replies'), post.replies);

    const likeBtn = node.querySelector('.like-btn');
    const skipBtn = node.querySelector('.skip-btn');
    const shareBtn = node.querySelector('.share-btn');
    applyReactionUI(likeBtn, skipBtn, post.reaction || null);

    // In the favorites view, un-liking a post should make it disappear from
    // that list immediately, matching how a "liked posts" view behaves
    // elsewhere -- this only removes the card, never calls the API twice.
    function removeFromFavoritesIfNeeded(reaction) {
      if (container === favoritesFeedEl && reaction !== 'liked') {
        postEl.remove();
      }
    }

    likeBtn.addEventListener('click', () => {
      const next = currentReaction(likeBtn, skipBtn) === 'liked' ? null : 'liked';
      setReaction(post.id, likeBtn, skipBtn, next).then(() => removeFromFavoritesIfNeeded(next));
      if (next === 'liked') {
        burstHeart(postEl);
        vibrate(15);
      }
    });
    skipBtn.addEventListener('click', () => {
      const next = currentReaction(likeBtn, skipBtn) === 'disliked' ? null : 'disliked';
      setReaction(post.id, likeBtn, skipBtn, next).then(() => removeFromFavoritesIfNeeded(next));
      if (next === 'disliked') vibrate([10, 30, 10]);
    });
    shareBtn.addEventListener('click', () => sharePost(post));

    // Instagram-style double-tap-to-like anywhere on the post body (but not
    // on the action buttons themselves, which already have their own tap
    // handling above).
    attachDoubleTap(postEl, (target) => {
      if (target.closest('.like-btn, .skip-btn, .share-btn')) return;
      setReaction(post.id, likeBtn, skipBtn, 'liked');
      burstHeart(postEl); // always show the burst, even if already liked
      vibrate(15);
    });

    container.appendChild(node);
  }

  async function sharePost(post) {
    const shareText = `"${post.text}" — ${post.author} on InfiniScroll`;
    if (navigator.share) {
      try {
        await navigator.share({ text: shareText });
      } catch (err) {
        if (err.name !== 'AbortError') console.error('Share failed:', err);
      }
    } else if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(shareText);
        showToast('Copied to clipboard');
      } catch (err) {
        console.error('Clipboard write failed:', err);
      }
    }
  }

  function currentReaction(likeBtn, skipBtn) {
    if (likeBtn.classList.contains('liked')) return 'liked';
    if (skipBtn.classList.contains('active')) return 'disliked';
    return null;
  }

  function applyReactionUI(likeBtn, skipBtn, reaction) {
    likeBtn.classList.toggle('liked', reaction === 'liked');
    likeBtn.setAttribute('aria-pressed', String(reaction === 'liked'));
    skipBtn.classList.toggle('active', reaction === 'disliked');
    skipBtn.setAttribute('aria-pressed', String(reaction === 'disliked'));
  }

  async function setReaction(postId, likeBtn, skipBtn, nextReaction) {
    const prevReaction = currentReaction(likeBtn, skipBtn);
    if (nextReaction === prevReaction) return; // no-op, nothing to send

    applyReactionUI(likeBtn, skipBtn, nextReaction); // optimistic — feels instant

    try {
      const res = await fetch(`/api/posts/${postId}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction: nextReaction }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
    } catch (err) {
      console.error('Failed to save reaction:', err);
      applyReactionUI(likeBtn, skipBtn, prevReaction); // revert on failure
    }
  }

  function burstHeart(postEl) {
    const burst = document.createElement('div');
    burst.className = 'heart-burst';
    burst.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M12 21s-6.72-4.36-9.33-8.2C.99 9.98 1.9 6 5.4 6c2.02 0 3.31 1.15 3.9 2.15C9.9 7.15 11.2 6 13.2 6c3.5 0 4.42 3.98 2.73 6.8C19.72 16.64 12 21 12 21z"/></svg>';
    burst.addEventListener('animationend', () => burst.remove());
    postEl.appendChild(burst);
  }

  // Fires onDoubleTap(target) when two taps land within 300ms of each other
  // and aren't just a scroll gesture (checked via a small movement
  // threshold so a flick/scroll never gets misread as a tap).
  function attachDoubleTap(el, onDoubleTap) {
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let downX = 0;
    let downY = 0;

    el.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });

    el.addEventListener('pointerup', (e) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > 10) return; // was a scroll/drag, not a tap

      const now = Date.now();
      const distanceFromLastTap = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY);
      if (now - lastTapTime < 300 && distanceFromLastTap < 40) {
        onDoubleTap(e.target);
        lastTapTime = 0; // consume, so a third quick tap doesn't re-trigger
      } else {
        lastTapTime = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
      }
    });
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

      data.posts.forEach((p) => renderPost(p, feedEl));
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

  // ---------- Stats overlay ----------

  function renderStatsRow(entry, maxAbsScore) {
    const row = document.createElement('div');
    row.className = 'stats-row';

    const score = entry.likes - entry.dislikes;
    const barWidthPct = maxAbsScore > 0 ? Math.max(4, (Math.abs(score) / maxAbsScore) * 100) : 4;
    const barColor = score >= 0 ? hashTextColor(entry.topic) : 'var(--text-secondary)';

    row.innerHTML = `
      <div class="stats-row-label">
        <span class="stats-row-topic" style="color: ${hashTextColor(entry.topic)}">${entry.topic}</span>
        <span class="stats-row-counts">${entry.likes} &hearts; &middot; ${entry.dislikes} skipped</span>
      </div>
      <div class="stats-bar-track">
        <div class="stats-bar-fill" style="width: ${barWidthPct}%; background: ${barColor}"></div>
      </div>
    `;
    return row;
  }

  async function openStats() {
    statsOverlay.classList.remove('hidden');
    statsBody.innerHTML = '<div class="stats-empty">Loading&hellip;</div>';

    try {
      const res = await fetch('/api/stats/topics');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      const topics = data.topics || [];
      const engaged = topics.filter((t) => t.likes > 0 || t.dislikes > 0);

      if (engaged.length === 0) {
        statsBody.innerHTML =
          '<div class="stats-empty">Heart or skip a few posts to see your trends here.</div>';
        return;
      }

      const maxAbsScore = Math.max(...engaged.map((t) => Math.abs(t.likes - t.dislikes)));
      statsBody.innerHTML = '';
      engaged.forEach((entry) => statsBody.appendChild(renderStatsRow(entry, maxAbsScore)));
    } catch (err) {
      console.error('Failed to load stats:', err);
      statsBody.innerHTML = '<div class="stats-empty">Couldn\'t load your stats right now.</div>';
    }
  }

  function closeStats() {
    statsOverlay.classList.add('hidden');
  }

  statsBtn.addEventListener('click', openStats);
  statsClose.addEventListener('click', closeStats);
  statsOverlay.addEventListener('click', (e) => {
    if (e.target === statsOverlay) closeStats(); // click on the backdrop, not the panel
  });

  // ---------- Favorites view ----------
  // A "your liked posts" view, not a crowd-sourced trending list -- there's
  // only one user here, so there's no real popularity signal beyond your own
  // reactions. Reuses renderPost/setReaction as-is, just targeting a second
  // feed container that's shown/hidden instead of destroying the live one
  // (so switching back preserves your scroll position in the live feed).

  let inFavoritesMode = false;

  async function loadFavorites() {
    favoritesFeedEl.innerHTML = '<div class="end-of-feed">Loading&hellip;</div>';

    try {
      const res = await fetch('/api/liked');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      favoritesFeedEl.innerHTML = '';
      if (!data.posts || data.posts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'end-of-feed';
        empty.textContent = "You haven't hearted anything yet.";
        favoritesFeedEl.appendChild(empty);
        return;
      }
      data.posts.forEach((p) => renderPost(p, favoritesFeedEl));
    } catch (err) {
      console.error('Failed to load favorites:', err);
      favoritesFeedEl.innerHTML = '<div class="end-of-feed">Couldn\'t load your favorites right now.</div>';
    }
  }

  favoritesBtn.addEventListener('click', () => {
    inFavoritesMode = !inFavoritesMode;
    favoritesBtn.classList.toggle('active', inFavoritesMode);
    favoritesBtn.setAttribute('aria-pressed', String(inFavoritesMode));
    feedEl.classList.toggle('feed-hidden', inFavoritesMode);
    favoritesFeedEl.classList.toggle('feed-hidden', !inFavoritesMode);
    if (inFavoritesMode) loadFavorites();
  });
})();
