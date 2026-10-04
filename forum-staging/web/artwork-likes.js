import { renderArtworkTags } from "./artwork-tags.js";

export function renderArtworkLikeButton(container, artwork, {
  onChange = () => {},
  request,
  status = () => {},
} = {}) {
  const button = document.createElement("button");
  button.className = "artwork-like-button";
  button.type = "button";

  function update() {
    const count = Number(artwork.likeCount ?? 0);
    button.classList.toggle("is-liked", Boolean(artwork.viewerLiked));
    button.setAttribute("aria-pressed", String(Boolean(artwork.viewerLiked)));
    button.setAttribute("aria-label", artwork.viewerLiked ? "Remove like" : "Like artwork");
    button.title = artwork.canLike ? (artwork.viewerLiked ? "Remove like" : "Like artwork") : "You cannot like your own artwork";
    button.disabled = artwork.canLike === false;
    button.textContent = `${artwork.viewerLiked ? "♥" : "♡"} ${count}`;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const likes = await request(`/api/attachments/${artwork.id}/likes`, {
        method: artwork.viewerLiked ? "DELETE" : "PUT",
        useCsrf: true,
      });
      Object.assign(artwork, likes);
      update();
      onChange(artwork);
    } catch {
      update();
      status("Could not update the artwork like.", true);
    }
  });

  update();
  container.append(button);
  return button;
}

export async function renderForumArtworkLike(figure, attachment, options) {
  renderArtworkTags(figure, attachment);
  try {
    const likes = await options.request(`/api/attachments/${attachment.id}/likes`);
    Object.assign(attachment, likes);
    const controls = document.createElement("div");
    controls.className = "post-attachment-likes";
    renderArtworkLikeButton(controls, attachment, options);
    figure.append(controls);
  } catch {
    // Images outside the art sections are intentionally not part of the gallery.
  }
}
