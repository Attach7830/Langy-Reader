import { $, api, element, message } from './ui.js';

const initialized = new WeakSet();
let current;
export function archiveTitleActions(job, { refresh, request = api }) {
  const root = element('div', 'form-stack');
  const id = job.id.replace(/^archive:/u, ''), endpoint = '/api/imports/anna/' + encodeURIComponent(id) + '/title';
  if (job.titleError) root.append(element('p', 'field-note', job.titleError === 'blocked'
    ? 'Anna’s Archive blocked the title lookup. It will retry automatically.'
    : 'The title lookup did not finish. It will retry automatically.'));
  const actions = element('div', 'button-row');
  const edit = element('button', 'button quiet small', 'Set title'); edit.type = 'button';
  edit.addEventListener('click', () => {
    const dialog = $('#archive-title-dialog'), form = $('#archive-title-form');
    if (!initialized.has(form)) {
      initialized.add(form);
      form.addEventListener('submit', async (event) => {
        event.preventDefault(); if (!form.reportValidity()) return;
        const visit = current, submit = form.querySelector('[type=submit]'); submit.disabled = true;
        message('#archive-title-error');
        try {
          await visit.request(visit.endpoint, { method: 'PATCH', body: { title: form.elements.title.value.trim() } });
          if (current === visit) dialog.close();
          await visit.refresh();
        } catch (error) { if (current === visit) message('#archive-title-error', error.message); }
        finally { if (current === visit) submit.disabled = false; }
      });
    }
    current = { endpoint, request, refresh }; form.elements.title.value = job.title || job.details?.title || '';
    form.querySelector('[type=submit]').disabled = false; message('#archive-title-error'); dialog.showModal(); form.elements.title.focus();
  });
  const retry = element('button', 'button quiet small', 'Retry title lookup'); retry.type = 'button'; retry.disabled = job.titlePending;
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    try { await request(endpoint + '/retry', { method: 'POST' }); await refresh(); }
    catch (error) { root.append(element('p', 'form-error', error.message)); retry.disabled = false; }
  });
  actions.append(edit, retry); root.append(actions); return root;
}
