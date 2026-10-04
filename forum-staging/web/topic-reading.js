// Save only posts that reach the viewport, rather than marking a fetched page read.
export function observeTopicReading(container, topicId, request, posts) {
  const positions = new Map(posts.filter(post => !post.deleted).map((post, index) => [post.id, index]));
  let pending = null;
  let inFlight = Promise.resolve();
  let timer = null;
  let stopped = false;
  const send = async () => {
    clearTimeout(timer);
    timer = null;
    const postId = pending;
    pending = null;
    if (!postId) return inFlight;
    inFlight = inFlight.catch(() => {}).then(() => request(`/api/topics/${topicId}/read`, {
        method: 'PUT', useCsrf: true, body: { postId },
      })).catch(() => {});
    await inFlight;
  };
  if (typeof IntersectionObserver === 'undefined') return () => {};
  const observer = new IntersectionObserver(entries => {
    if (stopped || document.visibilityState === 'hidden') return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const id = entry.target.dataset.postId;
      if (!pending || positions.get(id) > positions.get(pending)) pending = id;
      observer.unobserve(entry.target);
    }
    if (pending && !timer) timer = setTimeout(send, 600);
  }, { threshold: 0 });
  for (const post of container.querySelectorAll('[data-post-id]')) if (positions.has(post.dataset.postId)) observer.observe(post);
  return () => { stopped = true; observer.disconnect(); return send(); };
}
