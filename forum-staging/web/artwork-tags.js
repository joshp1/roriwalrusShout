export function renderArtworkTags(container, artwork) {
  const tags = document.createElement('div');
  tags.className = 'gallery-tags';
  for (const tag of artwork.tags ?? []) {
    const link = document.createElement('a');
    link.href = `/gallery?tag=${encodeURIComponent(tag)}`;
    link.textContent = `#${tag}`;
    tags.append(link);
  }
  container.append(tags);
  return tags;
}
