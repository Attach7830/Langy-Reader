import { $, element, message } from './ui.js';
import { displayedRanges } from './reading-vocabulary.js';

export function readingBookTools({ book, renderer, preferences, request, go, textEdition = () => false }) {
  const dialog = $('#book-tools-dialog'), form = $('#book-search-form'), results = $('#book-search-results'), guide = $('#character-guide-output');
  let epoch = 0, controller;
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!book()) return;
    const version = ++epoch; controller?.abort(); controller = new AbortController(); message('#book-tools-error');
    results.textContent = 'Searching…';
    try {
      const query = new URLSearchParams({ q: form.elements.query.value.trim() });
      if (textEdition()) query.set('view', 'epub');
      const answer = await request(`/api/books/${book().id}/search?${query}`, { signal: controller.signal });
      if (version !== epoch) return;
      results.replaceChildren(...answer.results.map((hit) => {
        const button = element('button', 'book-search-result'); button.type = 'button';
        const text = element('span'); text.append(document.createTextNode(hit.before), element('mark', '', hit.match), document.createTextNode(hit.after));
        button.append(element('strong', '', hit.title || hit.key), text);
        button.addEventListener('click', () => { dialog.close(); void go({ text: true, key: hit.key, from: hit.from, to: hit.to }); }); return button;
      }));
      if (!answer.results.length) results.textContent = 'No matching text.';
      if (answer.more) results.append(element('p', 'field-note', 'Showing the first 100 matches. Use a more specific phrase to narrow the results.'));
    } catch (error) { if (version === epoch && error.name !== 'AbortError') { results.replaceChildren(); message('#book-tools-error', error.message); } }
  });
  $('#generate-character-guide').addEventListener('click', async () => {
    if (!book() || book().l1Folder) return;
    const version = ++epoch; controller?.abort(); controller = new AbortController(); message('#book-tools-error'); guide.textContent = 'Building a guide from passages you have reached…';
    try {
      const page = renderer()?.audioUnit?.(), track = page?.track();
      if (!track) throw new Error('This page needs selectable text for a character guide.');
      const source = await request(`/api/books/${book().id}/vocabulary/sections/${encodeURIComponent(page.key)}`);
      const ranges = displayedRanges(track, source.text, book().language);
      if (!ranges.length) throw new Error('The current reading position could not be determined.');
      const answer = await request(`/api/books/${book().id}/character-guide`, { method: 'POST', signal: controller.signal, body: { key: page.key, through: Math.max(...ranges.map((range) => range.to)),
        query: $('#character-guide-query').value.trim(), language: preferences().summaryLanguage } });
      if (version === epoch) guide.textContent = answer.text;
    } catch (error) { if (version === epoch && error.name !== 'AbortError') { guide.replaceChildren(); message('#book-tools-error', error.message); } }
  });
  dialog.addEventListener('close', () => { epoch++; controller?.abort(); });
  $('#book-tools-button').addEventListener('click', () => { if (book()) { guide.replaceChildren(); results.replaceChildren(); message('#book-tools-error'); dialog.showModal(); } });
  return { reset() { epoch++; controller?.abort(); if (dialog.open) dialog.close(); } };
}
