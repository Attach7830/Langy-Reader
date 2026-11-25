import { bookCovers, validCoverStyle } from '../shared/book-covers.js';
import { element, icon } from './ui.js';
import { coverCache } from './cover-cache.js';

let visibleCovers;
const coverRequests = new WeakMap();
function loadCover(image, book) {
  const load = () => { void coverCache.source(book).then((url) => { if (url) image.src = url; }); };
  if (typeof IntersectionObserver === 'undefined') { load(); return; }
  visibleCovers ||= new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting && target.isConnected) continue;
      visibleCovers.unobserve(target); const request = coverRequests.get(target); coverRequests.delete(target);
      if (target.isConnected) request?.();
    }
  }, { rootMargin: '300px' });
  coverRequests.set(image, load); visibleCovers.observe(image);
}

export function bookCover(book, { preview = false } = {}) {
  const style = validCoverStyle(book.coverStyle) ? book.coverStyle : 'auto';
  const title = book.title || 'Your book';
  const cover = element('div', `book-cover${book.id === 'sample' && style === 'auto' ? ' cover-sample' : ''}`);
  cover.setAttribute('aria-hidden', 'true'); cover.dataset.cover = style;
  cover.dataset.palette = book.id === 'sample' ? '0' : String(title.codePointAt(0) % 4);
  cover.append(element('span', 'cover-format', (book.format || 'EPUB').toUpperCase()),
    element('span', 'cover-title', title.length > 50 ? `${title.slice(0, 48)}…` : title));
  if (book.id === 'sample' && style === 'auto') cover.append(icon('coffee'));
  else cover.append(element('span', 'cover-author', book.author || (preview ? 'Author' : '')), element('span', 'cover-decoration'));
  if (book.thumbnailType && style === 'auto') {
    const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy';
    loadCover(image, book);
    image.addEventListener('error', () => image.remove(), { once: true }); cover.append(image);
  }
  return cover;
}

export function bookCoverPicker(form, host) {
  let book = {};
  const inputs = [];
  for (const [value, name] of Object.entries(bookCovers)) {
    const label = element('label', 'book-cover-option'), input = document.createElement('input');
    input.type = 'radio'; input.name = 'coverStyle'; input.value = value; input.setAttribute('aria-label', name);
    const preview = element('span', 'book-cover-preview');
    label.append(input, preview, element('span', 'book-cover-name', name)); host.append(label); inputs.push({ input, preview });
  }
  function refresh() {
    for (const { input, preview } of inputs) preview.replaceChildren(bookCover({ ...book, title: form.elements.title.value, author: form.elements.author.value, coverStyle: input.value }, { preview: true }));
  }
  form.elements.title.addEventListener('input', refresh); form.elements.author.addEventListener('input', refresh);
  return { set(value = {}) { book = value; form.elements.coverStyle.value = validCoverStyle(book.coverStyle) ? book.coverStyle : 'auto'; refresh(); }, refresh };
}
