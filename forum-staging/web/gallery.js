import { renderArtworkTags } from "./artwork-tags.js";
import { renderArtworkLikeButton } from "./artwork-likes.js";
import { loadSession, request } from "./client.js";
import { awaitPresence } from "./presence-gate.js";
import { renderUsernameColor } from "./username-color.js";

const grid = document.querySelector("#gallery-grid");
const status = document.querySelector("#gallery-status");
const more = document.querySelector("#gallery-more");
const sortButtons = [...document.querySelectorAll("[data-gallery-sort]")];
const dialog = document.querySelector("#gallery-dialog");
const dialogTitle = document.querySelector("#gallery-dialog-title");
const dialogImage = document.querySelector("#gallery-dialog-image");
const dialogDetails = document.querySelector("#gallery-dialog-details");
const dialogClose = document.querySelector("#gallery-dialog-close");

const filters = document.querySelector('#gallery-filters');
const sectionButtons = [...document.querySelectorAll('[data-gallery-section]')];
const tagTabs = document.querySelector('#gallery-tags');
let currentSection = '';
let currentTag = '';
let currentArtist = '';
let knownTags = [];
let tagCounts = new Map();
let loadVersion = 0;
let artwork = [];
let currentSort = "newest";
let nextOffset = 0;
let loading = false;

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

function updateReputation(artistId, reputation) {
  for (const item of artwork) {
    if (item.artistId === artistId) item.artistReputation = reputation;
  }
  for (const element of grid.querySelectorAll(`[data-gallery-artist-id="${CSS.escape(artistId)}"]`)) {
    element.textContent = `${reputation} rep`;
  }
}

function showArtwork(item) {
  dialogTitle.textContent = item.topicTitle;
  dialogImage.src = item.url;
  dialogImage.alt = item.name;

  const artistLink = document.createElement("a");
  artistLink.href = `/profile?username=${encodeURIComponent(item.artistUsername)}`;
  artistLink.textContent = item.artist;
  renderUsernameColor(artistLink, item.usernameColor, item.usernameColorEffect);

  const discussionLink = document.createElement("a");
  discussionLink.className = "primary-button";
  discussionLink.href = item.forumUrl;
  discussionLink.textContent = "View discussion";

  const information = document.createElement("p");
  information.append("By ", artistLink, ` · ${item.likeCount} like${item.likeCount === 1 ? "" : "s"} · ${item.artistReputation} rep`);
  dialogDetails.replaceChildren(information, discussionLink);
  renderArtworkTags(dialogDetails, item);
  if (item.canEditTags) {
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = 'Tags (comma separated, up to 10)';
    const input = document.createElement('input');
    input.value = (item.tags ?? []).join(', ');
    input.maxLength = 420;
    const suggestions = document.createElement('datalist');
    suggestions.id = 'artwork-tag-suggestions';
    const updateSuggestions = () => {
      suggestions.replaceChildren();
      for (const tag of knownTags) {
        const option = document.createElement('option');
        option.value = [...input.value.split(',').slice(0, -1).map(value => value.trim()), tag].join(', ');
        suggestions.append(option);
      }
    };
    input.addEventListener('input', updateSuggestions);
    updateSuggestions();
    input.setAttribute('list', suggestions.id);
    label.append(input);
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save tags';
    const feedback = document.createElement('p');
    feedback.setAttribute('role', 'status');
    form.append(label, suggestions, save, feedback);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const tags = input.value.split(',').map(tag => tag.trim()).filter(Boolean);
      if (tags.length > 10 || tags.some(tag => tag.length > 40)) {
        feedback.textContent = 'Use up to 10 tags, each no longer than 40 characters.';
        return;
      }
      save.disabled = true;
      try {
        const result = await request(`/api/attachments/${item.id}/tags`, {
          method: 'PUT', useCsrf: true, body: { tags },
        });
        item.tags = result.tags;
        dialog.close();
        await loadGallery();
      } catch {
        feedback.textContent = 'Could not save tags. Try again.';
      } finally { save.disabled = false; }
    });
    dialogDetails.append(form);
  }
  dialog.showModal();
}

function renderCard(item) {
  const article = document.createElement("article");
  article.className = "gallery-item";

  const imageButton = document.createElement("button");
  imageButton.className = "gallery-image-button";
  imageButton.type = "button";
  imageButton.setAttribute("aria-label", `Open ${item.name}`);
  const image = document.createElement("img");
  image.alt = item.name;
  image.decoding = "async";
  image.loading = "lazy";
  image.src = item.thumbnailUrl;
  imageButton.append(image);
  imageButton.addEventListener("click", () => showArtwork(item));

  const information = document.createElement("div");
  information.className = "gallery-item-information";
  const title = document.createElement("a");
  title.className = "gallery-item-title";
  title.href = item.forumUrl;
  title.textContent = item.topicTitle;

  const artistRow = document.createElement("div");
  artistRow.className = "gallery-artist-row";
  const artistLink = document.createElement("a");
  artistLink.href = `/profile?username=${encodeURIComponent(item.artistUsername)}`;
  artistLink.textContent = item.artist;
  renderUsernameColor(artistLink, item.usernameColor, item.usernameColorEffect);
  const reputation = document.createElement("span");
  reputation.className = "gallery-reputation";
  reputation.dataset.galleryArtistId = item.artistId;
  reputation.textContent = `${item.artistReputation} rep`;
  artistRow.append(artistLink, reputation);

  const actions = document.createElement("div");
  actions.className = "gallery-item-actions";
  renderArtworkLikeButton(actions, item, {
    request,
    status: setStatus,
    onChange(updated) {
      updateReputation(updated.artistId, updated.artistReputation);
    },
  });
  const discussion = document.createElement("a");
  discussion.href = item.forumUrl;
  discussion.textContent = "Forum";
  actions.append(discussion);

  information.append(title, artistRow, actions);
  renderArtworkTags(information, item);
  article.append(imageButton, information);
  return article;
}

function selectSort(sort) {
  currentSort = sort;
  for (const button of sortButtons) {
    const selected = button.dataset.gallerySort === sort;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

async function loadGallery({ append = false } = {}) {
  if (append && loading) return;
  const version = ++loadVersion;
  loading = true;
  more.disabled = true;
  for (const button of sortButtons) button.disabled = true;
  setStatus("Loading gallery...");
  if (!append) {
    artwork = [];
    nextOffset = 0;
    grid.replaceChildren();
  }
  try {
    const parameters = new URLSearchParams({
      limit: "24",
      offset: String(nextOffset),
      sort: currentSort,
      section: currentSection,
      tag: currentTag,
      artist: currentArtist,
    });
    const result = await request(`/api/gallery?${parameters}`);
    if (version !== loadVersion) return;
    knownTags = result.tags ?? [];
    tagCounts = new Map((result.tagUsage ?? []).map(item => [item.tag, item.count]));
    renderTagTabs();
    artwork.push(...result.artwork);
    grid.append(...result.artwork.map(renderCard));
    nextOffset = result.nextOffset;
    more.hidden = !result.hasMore;
    setStatus(artwork.length === 0
      ? "No artwork matches these filters."
      : `${artwork.length} image${artwork.length === 1 ? "" : "s"} shown${result.hasMore ? "; more available" : ""}.`);
  } catch {
    if (version !== loadVersion) return;
    setStatus("Could not load the gallery. Try again.", true);
  } finally {
    if (version === loadVersion) {
      loading = false;
      more.disabled = false;
      for (const button of sortButtons) button.disabled = false;
    }
  }
}

function updateRoute() {
  const parameters = new URLSearchParams();
  if (currentSort !== 'newest') parameters.set('sort', currentSort);
  if (currentSection) parameters.set('section', currentSection);
  if (currentTag) parameters.set('tag', currentTag);
  if (currentArtist) parameters.set('artist', currentArtist);
  history.replaceState(history.state, '', `/gallery${parameters.size ? '?' + parameters : ''}`);
  loadRoute();
}

function renderTagTabs() {
  tagTabs.replaceChildren();
  for (const tag of ['', ...new Set([...knownTags, ...(currentTag ? [currentTag] : [])])]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tag ? `#${tag}${tagCounts.has(tag) ? ` (${tagCounts.get(tag)})` : ''}` : 'All tags';
    button.setAttribute('aria-pressed', String(tag === currentTag));
    button.addEventListener('click', () => { currentTag = tag; updateRoute(); });
    tagTabs.append(button);
  }
}

filters.addEventListener('submit', event => {
  event.preventDefault();
  currentTag = filters.elements.tag.value.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  currentArtist = filters.elements.artist.value.trim();
  updateRoute();
});
filters.addEventListener('reset', event => {
  event.preventDefault();
  currentTag = currentArtist = currentSection = '';
  updateRoute();
});
for (const button of sectionButtons) button.addEventListener('click', () => {
  currentSection = button.dataset.gallerySection;
  updateRoute();
});
for (const button of sortButtons) button.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? sortButtons.length - 1
    : (sortButtons.indexOf(button) + (event.key === 'ArrowRight' ? 1 : -1) + sortButtons.length) % sortButtons.length;
  sortButtons[index].click();
  sortButtons[index].focus();
});

function loadRoute() {
  const parameters = new URLSearchParams(location.search);
  currentSection = parameters.get('section') ?? '';
  currentTag = parameters.get('tag') ?? '';
  currentArtist = parameters.get('artist') ?? '';
  filters.elements.tag.value = currentTag;
  filters.elements.artist.value = currentArtist;
  for (const button of sectionButtons) button.setAttribute('aria-pressed', String(button.dataset.gallerySection === currentSection));
  const requestedSort = new URLSearchParams(location.search).get("sort");
  selectSort(requestedSort === "liked" ? "liked" : "newest");
  return loadGallery();
}

for (const button of sortButtons) {
  button.addEventListener("click", () => {
    const sort = button.dataset.gallerySort;
    if (sort === currentSort && artwork.length) return;
    selectSort(sort);
    updateRoute();
  });
}
more.addEventListener("click", () => loadGallery({ append: true }));
dialogClose.addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
dialog.addEventListener("close", () => {
  dialogImage.removeAttribute("src");
});
window.addEventListener("rw:routechange", () => {
  if (location.pathname === "/gallery") loadRoute();
});

async function init() {
  await awaitPresence();
  try {
    await loadSession();
  } catch {
    location.assign("/account#sign-in");
    return;
  }
  await loadRoute();
}

init();
