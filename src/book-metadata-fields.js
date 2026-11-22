import { filenameTitle } from '../shared/book-metadata.js';

const defaultDetect = async (file, options) => (await import('./book-metadata.js')).detectBookMetadata(file, options);

export function bookMetadataFields({ form, status, detect = defaultDetect, active = () => true, timeoutMs = 20000 }) {
  const names = ['title', 'author', 'language'], manual = new Set();
  let revision = 0, controller, pending = Promise.resolve(), automatic = {};
  const say = (text = '') => { status.textContent = text; status.hidden = !text; };
  for (const name of names) form.elements[name].addEventListener('input', () => manual.add(name));
  function cancel() { revision++; controller?.abort(); controller = null; pending = Promise.resolve(); say(); }
  function reset() { cancel(); manual.clear(); automatic = {}; }
  function start(file) {
    cancel();
    for (const name of names) {
      const input = form.elements[name];
      if (!manual.has(name) && input.value === automatic[name] && !input.readOnly) input.value = '';
    }
    automatic = {};
    if (!file) return;
    if (!manual.has('title') && !form.elements.title.value) automatic.title = form.elements.title.value = filenameTitle(file.name);
    const before = Object.fromEntries(names.map((name) => [name, form.elements[name].value]));
    const id = revision, job = controller = new AbortController();
    say('Detecting title, author and language…');
    pending = (async () => {
      let timer;
      try {
        const cancelled = new Promise((_, reject) => job.signal.addEventListener('abort', () => reject(job.signal.reason), { once: true }));
        timer = setTimeout(() => job.abort(new Error('Detection timed out.')), timeoutMs);
        const result = await Promise.race([Promise.resolve().then(() => detect(file, { signal: job.signal })), cancelled]);
        if (id !== revision || !active()) return;
        for (const name of names) {
          const input = form.elements[name];
          if (result[name] && !manual.has(name) && !input.readOnly && input.value === before[name]) automatic[name] = input.value = result[name];
        }
        const missing = [!result.author && 'author', !result.language && 'language'].filter(Boolean);
        say(missing.length ? `Available details filled in. ${missing.join(' and ')} not detected; you can enter them manually.`
          : 'Book details detected. Review or edit them before importing.');
      } catch {
        if (id === revision && active()) say('Details could not be detected. You can enter them manually.');
      } finally { clearTimeout(timer); }
    })();
  }
  return { start, cancel, reset, async ready() { for (;;) { const work = pending; await work; if (work === pending) return; } } };
}
