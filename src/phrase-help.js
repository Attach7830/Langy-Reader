import { nodeLanguage, bookLanguages } from '../shared/language.js';
import { languageHelpPreferences } from '../shared/language-defaults.js';

export function phraseHelp({ book, preferences, request, onSelection = () => {} }) {
  const panel = document.querySelector('#phrase-help'), quote = panel.querySelector('blockquote'), answer = panel.querySelector('[data-phrase-answer]');
  const explain = panel.querySelector('[data-explain-phrase]'), close = panel.querySelector('[data-close-phrase]');
  let selected, controller, epoch = 0, scheduled;
  function clear() { epoch++; controller?.abort(); clearTimeout(scheduled); selected = null; panel.hidden = true; answer.textContent = ''; explain.disabled = false; }
  function inspect(root) {
    const doc = root.ownerDocument, selection = doc.getSelection();
    if (panel.contains(document.activeElement)) return;
    if (!book() || book().l1Folder || !selection?.rangeCount || selection.isCollapsed) { if (selected?.root === root) clear(); return; }
    const range = selection.getRangeAt(0), phrase = selection.toString().trim();
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer) || !phrase || phrase.length > 700) { if (selected?.root === root) clear(); return; }
    if (selected?.phrase === phrase && selected.root === root) return;
    const parent = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const block = parent.closest('p,li,blockquote,h1,h2,h3,div') || parent;
    let context = [block.previousElementSibling?.textContent || '', block.textContent || '', block.nextElementSibling?.textContent || ''].join('\n').trim();
    let at = context.indexOf(phrase);
    if (at < 0) {
      const before = range.cloneRange(), after = range.cloneRange();
      before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
      after.selectNodeContents(root); after.setStart(range.endContainer, range.endOffset);
      const prefix = before.toString().slice(-1200);
      context = prefix + phrase + after.toString().slice(0, 2100); at = prefix.length;
    }
    context = context.slice(Math.max(0, at - 1200), Math.max(0, at - 1200) + 4000);
    const rect = range.getBoundingClientRect(), frame = doc.defaultView.frameElement?.getBoundingClientRect();
    const left = rect.left + (frame?.left || 0), bottom = rect.bottom + (frame?.top || 0);
    clear(); selected = { root, phrase, context, book: book().id,
      language: nodeLanguage(range.startContainer, book().language, phrase, bookLanguages(book())) };
    onSelection(); quote.textContent = phrase; panel.hidden = false;
    panel.style.left = `${Math.max(12, Math.min(left, window.innerWidth - Math.min(420, window.innerWidth - 24) - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(bottom + 10, window.innerHeight - 240))}px`;
  }
  panel.addEventListener('pointerdown', (event) => { if (event.target.closest('button')) event.preventDefault(); });
  close.addEventListener('click', clear);
  explain.addEventListener('click', async () => {
    if (!selected || explain.disabled || book()?.l1Folder) return;
    const value = selected, visit = ++epoch; controller?.abort(); controller = new AbortController();
    explain.disabled = true; answer.textContent = 'Explaining phrase…';
    try {
      const result = await request('/api/ai/phrase', { method: 'POST', signal: controller.signal,
        body: { phrase: value.phrase, context: value.context, language: value.language, translationLanguage: languageHelpPreferences(preferences(), value.language).translationLanguage || 'en' } });
      if (visit === epoch && book()?.id === value.book) answer.textContent = result.text;
    } catch (error) { if (visit === epoch && error.name !== 'AbortError') answer.textContent = error.message; }
    finally { if (visit === epoch) explain.disabled = false; }
  });
  function bind(root) {
    const doc = root.ownerDocument;
    const update = () => { clearTimeout(scheduled); scheduled = setTimeout(() => inspect(root), 160); };
    doc.addEventListener('selectionchange', update); root.addEventListener('pointerup', update); root.addEventListener('keyup', update);
    return () => { doc.removeEventListener('selectionchange', update); root.removeEventListener('pointerup', update); root.removeEventListener('keyup', update); if (selected?.root === root) clear(); };
  }
  return { bind, clear, keydown(event) { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); clear(); return true; } return false; } };
}
