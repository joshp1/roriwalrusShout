import { parseFragment } from 'parse5';

const discardedElements = new Set([
  'iframe',
  'noscript',
  'script',
  'style',
  'template',
]);

function collectText(node) {
  if (node.nodeName === '#text') {
    return node.value;
  }
  if (discardedElements.has(node.tagName)) {
    return '';
  }
  return (node.childNodes ?? []).map(collectText).join('');
}

export function stripHtmlTags(value) {
  if (typeof value !== 'string' || !value.includes('<') && !value.includes('&')) {
    return value;
  }
  return collectText(parseFragment(value));
}