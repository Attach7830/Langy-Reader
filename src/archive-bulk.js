import { element } from './ui.js';

export function archiveBulk(form) {
  const toggle = document.querySelector('#archive-bulk-mode'), shared = document.querySelector('#archive-shared-author');
  const host = document.querySelector('#archive-bulk-rows'), panel = document.querySelector('#archive-bulk-panel');
  const title = form.elements.title.closest('label'), author = form.elements.author.closest('label');
  let rows = [];
  function update() {
    panel.hidden = !toggle.checked; document.querySelector('#archive-reference-field').hidden = toggle.checked;
    title.hidden = toggle.checked; author.hidden = toggle.checked && !shared.checked;
    for (const row of rows) row.author.parentElement.hidden = shared.checked;
    document.querySelector('#archive-add-row').disabled = rows.length >= 50;
  }
  function add() {
    if (rows.length >= 50) return;
    const root = element('div', 'archive-bulk-row'), row = { root };
    for (const [key, caption, placeholder] of [['reference', 'Book link or MD5', 'Anna’s Archive edition link'], ['title', 'Title', 'Automatic if blank'], ['author', 'Author', 'Automatic if blank']]) {
      const label = element('label', 'field', caption), input = document.createElement('input');
      input.placeholder = placeholder; input.maxLength = key === 'reference' ? 2000 : key === 'title' ? 250 : 200;
      input.setAttribute('aria-label', caption); row[key] = input; label.append(input); root.append(label);
    }
    const remove = element('button', 'button quiet small', 'Remove row'); remove.type = 'button';
    remove.addEventListener('click', () => { rows = rows.filter((item) => item !== row); root.remove(); update(); });
    root.append(remove); host.append(root); rows.push(row); update();
  }
  toggle.addEventListener('change', update); shared.addEventListener('change', update);
  document.querySelector('#archive-add-row').addEventListener('click', add);
  return { enabled: () => toggle.checked, sameAuthor: () => shared.checked,
    reset() { toggle.checked = false; shared.checked = false; rows = []; host.replaceChildren(); add(); add(); update(); },
    value() {
      const books = rows.map((row) => Object.fromEntries(['reference', 'title', 'author'].map((key) => [key, row[key].value.trim()]))).filter((book) => book.reference || book.title || book.author);
      if (!books.length || books.some((book) => !book.reference)) throw new Error('Add a book link or MD5 for each filled row.');
      return books;
    },
  };
}
