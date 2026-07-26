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
    const postEl = node.querySelector('.post');
    node.querySelector('.post-topic').textContent = post.topic || 'misc';
    node.querySelector('.post-text').textContent = post.text;
    node.querySelector('.post-author').textContent = post.author;
    node.querySelector('.post-timestamp').textContent = formatTimestamp(post.timestamp);

    const likeBtn = node.querySelector('.like-btn');
    const skipBtn = node.querySelector('.skip-btn');
    applyReactionUI(likeBtn, skipBtn, post.reaction || null);

    likeBtn.addEventListener('click', () => {
      const next = currentReaction(likeBtn, skipBtn) === 'liked' ? null : 'liked';
      setReaction(post.id, likeBtn, skipBtn, next);
      if (next === 'liked') burstHeart(postEl);
    });
    skipBtn.addEventListener('click', () => {
      const next = currentReaction(likeBtn, skipBtn) === 'disliked' ? null : 'disliked';
      setReaction(post.id, likeBtn, skipBtn, next);
    });

    // Instagram-style double-tap-to-like anywhere on the post body (but not
    // on the action buttons themselves, which already have their own tap
    // handling above).
    attachDoubleTap(postEl, (target) => {
      if (target.closest('.like-btn, .skip-btn')) return;
      setReaction(post.id, likeBtn, skipBtn, 'liked');
      burstHeart(postEl); // always show the burst, even if already liked
    });

    feedEl.appendChild(node);
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
