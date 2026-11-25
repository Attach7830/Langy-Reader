import { $, message } from './ui.js';
import { displayedRanges } from './reading-vocabulary.js';

export function pageQuestions({ book, renderer, preferences, request }) {
  const form = $('#summary-question-form'), output = $('#summary-question-answer'), submit = $('#summary-question-submit');
  let epoch = 0, controller;
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!book() || book().l1Folder || submit.disabled || !form.reportValidity()) return;
    const version = ++epoch, active = book(); controller?.abort(); controller = new AbortController(); submit.disabled = true;
    message('#summary-question-error'); output.textContent = 'Reading your question…'; output.lang = preferences().summaryLanguage;
    try {
      const page = renderer()?.audioUnit?.(), track = page?.track(); if (!track) throw new Error('This page needs selectable text.');
      const source = await request(`/api/books/${active.id}/vocabulary/sections/${encodeURIComponent(page.key)}`);
      const ranges = displayedRanges(track, source.text, active.language); if (!ranges.length) throw new Error('The current page position could not be determined.');
      const answer = await request(`/api/books/${active.id}/question`, { method: 'POST', signal: controller.signal, body: { key: page.key,
        from: Math.min(...ranges.map((range) => range.from)), through: Math.max(...ranges.map((range) => range.to)), scope: form.elements.scope.value,
        question: form.elements.question.value.trim(), language: preferences().summaryLanguage } });
      if (version === epoch && book()?.id === active.id) output.textContent = answer.text;
    } catch (error) { if (version === epoch && error.name !== 'AbortError') { output.replaceChildren(); message('#summary-question-error', error.message); } }
    finally { if (version === epoch) { controller = null; submit.disabled = false; } }
  });
  return { reset() { epoch++; controller?.abort(); controller = null; submit.disabled = false; output.replaceChildren(); message('#summary-question-error'); } };
}
