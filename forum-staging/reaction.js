import emojiRegex from 'emoji-regex';

export function isValidReaction(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) {
    return false;
  }
  const matches = [...value.matchAll(emojiRegex())];
  return matches.length === 1
    && (matches[0][0] === value || `${matches[0][0]}\ufe0f` === value);
}