const decoded = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
const archiveOrigin = 'https://epub.invalid/';
export function epubLinkTarget(href, section, spine) {
  try {
    const base = new URL(section.url || section.href, archiveOrigin), link = new URL(href, base);
    if (link.origin !== new URL(archiveOrigin).origin || /^[a-z]+:|^\/\//iu.test(href)) return null;
    const destination = spine.find((item) => decoded(new URL(item.url || item.href, archiveOrigin).pathname) === decoded(link.pathname));
    return destination ? { index: destination.index, fragment: decoded(link.hash.slice(1)) } : null;
  } catch { return null; }
}

export function bindBookLinks(doc, { section, spine, follow, error = () => {} }) {
  const clicked = (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || event.defaultPrevented || event.button > 0) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (/^[a-z]+:|^\/\//iu.test(href)) return;
    const target = epubLinkTarget(href, section, spine);
    if (!target) return error(new Error('This book link has no readable destination.'));
    Promise.resolve(follow(target)).catch(error);
  };
  doc.addEventListener('click', clicked, true);
  return () => doc.removeEventListener('click', clicked, true);
}

export function pdfLinkLayer(annotations, viewport, follow) {
  const layer = document.createElement('div'); layer.className = 'pdf-links';
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link' && annotation.annotationType !== 2 || !Array.isArray(annotation.rect)) continue;
    const rect = viewport.convertToViewportRectangle(annotation.rect);
    if (!rect.every(Number.isFinite)) continue;
    const link = document.createElement('a'); link.className = 'pdf-book-link';
    link.style.cssText = `left:${Math.min(rect[0], rect[2])}px;top:${Math.min(rect[1], rect[3])}px;width:${Math.abs(rect[2] - rect[0])}px;height:${Math.abs(rect[3] - rect[1])}px`;
    link.setAttribute('aria-label', annotation.contentsObj?.str || 'Follow book link');
    if (annotation.dest != null) {
      link.href = '#book-link';
      link.addEventListener('click', (event) => { event.preventDefault(); void follow(annotation.dest); });
    } else {
      try {
        const url = new URL(annotation.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
        link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      } catch { continue; }
    }
    layer.append(link);
  }
  return layer;
}
