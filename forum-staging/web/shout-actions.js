// These commands only change presentation; they never perform moderation actions.
// Add commands here. {text} is replaced with everything after the command.
// Commands with {text} require an argument unless a defaultText is provided.
export const shoutActions = Object.freeze({
  me: { template: '{text}' },
  kick: { template: 'kicks {text}' },
  hug: { template: 'hugs {text}' },
  slap: { template: 'slaps {text} with a large trout' },
  highfive: { template: 'high-fives {text}' },
  wave: { template: 'waves at {text}', defaultText: 'everyone' },
  dance: { template: 'dances {text}', defaultText: 'around the room' },
  shrug: { template: 'shrugs {text}', defaultText: 'helplessly' },
  laugh: { template: 'laughs {text}', defaultText: 'out loud' },
  cheer: { template: 'cheers for {text}', defaultText: 'everyone' },
});

export function parseShoutAction(body) {
  if (typeof body !== 'string') return null;
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(body.trim());
  if (!match) return null;
  const command = match[1].toLowerCase();
  if (!Object.hasOwn(shoutActions, command)) return null;
  const action = shoutActions[command];
  const text = match[2]?.trim() || action.defaultText || '';
  if (action.template.includes('{text}') && !text) return null;
  return action.template.replaceAll('{text}', () => text);
}

export function renderShoutBody(container, shout, renderMarkdown) {
  const action = parseShoutAction(shout.body);
  container.classList.toggle('shout-body-action', action !== null);
  if (action === null) {
    renderMarkdown(container, shout.body, shout.mentionAccounts ?? shout.mentionUsernames);
    return;
  }
  const author = container.ownerDocument.createElement('span');
  author.className = 'shout-action-author';
  author.textContent = `* ${shout.author} `;
  const content = container.ownerDocument.createElement('div');
  content.className = 'shout-action-text';
  renderMarkdown(content, action, shout.mentionAccounts ?? shout.mentionUsernames);
  container.replaceChildren(author, content);
}

export function alignShoutActionMetadata(meta, body) {
  const author = body.querySelector('.shout-action-author');
  const profile = meta.querySelector('.profile-link');
  if (!author || !profile) return;
  // Move the real profile link, preserving its avatar, colors and interactions.
  author.replaceChildren('* ', profile, ' ');
  const pin = meta.querySelector('.shout-pin-indicator');
  if (pin) author.append(pin, ' ');
}
