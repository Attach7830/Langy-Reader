import { $, element, toast } from './ui.js';
import { dismissOnBackdrop } from './dialog-backdrop.js';

async function settleKeyboard() {
  if (!window.matchMedia?.('(pointer: coarse)').matches) return;
  // Closing a numeric field can resize the reader while the phone keyboard
  // retracts. Map the requested page after that layout has settled.
  await new Promise((resolve) => {
    const viewport = window.visualViewport;
    let quiet, deadline;
    function finish() {
      clearTimeout(quiet); clearTimeout(deadline);
      window.removeEventListener('resize', changed); viewport?.removeEventListener('resize', changed); resolve();
    }
    function changed() { clearTimeout(quiet); quiet = setTimeout(finish, 180); }
    window.addEventListener('resize', changed); viewport?.addEventListener('resize', changed);
    deadline = setTimeout(finish, 1200); changed();
  });
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
}

export function bookPageJump({ renderer, book, go, focus = () => {} }) {
  const dialog = $('#page-jump-dialog'), form = $('#page-jump-form');
  const section = $('#page-jump-section'), input = $('#page-jump-number'), note = $('#page-jump-note');
  let owner, pdf;
  dismissOnBackdrop(dialog, focus);
  function range() {
    const known = pdf || Number(section.value) === owner.sectionIndex;
    const pages = `${owner.pageCount} ${owner.pageCount === 1 ? 'page' : 'pages'}`;
    if (known) input.max = String(owner.pageCount); else input.removeAttribute('max');
    note.textContent = pdf ? `This PDF has ${pages}.`
      : `${known ? `This section has ${pages}. ` : ''}EPUB page numbers restart in each section and change with text size. Choose any section to jump within it.`;
  }
  section.addEventListener('change', () => { input.value = '1'; range(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!owner || renderer() !== owner || !form.reportValidity()) return;
    const current = owner, isPdf = pdf, page = input.valueAsNumber, index = Number(section.value);
    dialog.close(); focus();
    try {
      await settleKeyboard();
      if (renderer() !== current) return;
      const moved = await go(isPdf ? page : { index, page });
      if (moved !== false && renderer() === current && !isPdf && page > current.pageCount) {
        toast(`This section has ${current.pageCount} ${current.pageCount === 1 ? 'page' : 'pages'}. Opened its last page.`);
      }
    } catch { /* The reader displays navigation failures. */ }
  });
  return { open() {
    owner = renderer(); if (!owner || !owner.pageCount || dialog.open) return;
    pdf = book().format === 'pdf';
    $('#page-jump-section-field').hidden = pdf;
    section.replaceChildren(...(owner.pageSections || []).map(({ index, label }) => {
      const option = element('option', '', label); option.value = String(index); return option;
    }));
    section.value = String(owner.sectionIndex ?? 0);
    input.value = String(owner.pageNumber); range();
    dialog.showModal(); input.focus(); input.select();
  } };
}
