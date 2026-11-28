import { translateUI } from './i18n.js';

export function syncPositionDialog({ dialog, available, onPending }) {
  const doc = dialog.ownerDocument;
  const message = dialog.querySelector('#sync-position-message');
  const error = dialog.querySelector('#sync-position-error');
  const keep = dialog.querySelector('#sync-keep');
  const close = dialog.querySelector('[data-close]');
  const buttons = { audiobookshelf: dialog.querySelector('#abs-sync-resume'), reading: dialog.querySelector('#sync-resume') };
  const offers = new Map(), deferred = new Map();
  let deciding, failed;

  function visible() {
    return [...offers].filter(([source, offer]) => deferred.get(source) !== offer.key);
  }

  function matching(choices) {
    const reading = choices.get('reading'), audio = choices.get('audiobookshelf');
    return Number.isFinite(reading?.percentage) && Number.isFinite(audio?.percentage)
      && Math.abs(reading.percentage - audio.percentage) < .00001;
  }

  function render() {
    onPending(offers.size > 0);
    if (deciding) return;
    const choices = new Map(visible());
    if (!available() || !choices.size) {
      if (dialog.open) dialog.close();
      return;
    }
    const same = matching(choices);
    const different = choices.size > 1 && !same;
    const first = choices.get('reading') || choices.get('audiobookshelf');
    const savedAt = first.timestamp > 0 ? ` (${new Date(first.timestamp * 1000).toLocaleString()})` : '';
    message.textContent = same ? `Audiobookshelf and ${first.device} saved a position at ${first.label}.`
      : different ? translateUI('Your devices saved different positions for this book.')
      : `${first.device} saved a different position at ${first.label}${savedAt}.`;
    for (const [source, button] of Object.entries(buttons)) {
      const offer = choices.get(source);
      button.hidden = !offer || same && source === 'audiobookshelf';
      button.classList.toggle('primary', !different);
      button.classList.toggle('secondary', different);
      button.textContent = different && offer ? `${offer.device} (${offer.label})` : translateUI('Resume there');
    }
    const failure = failed && choices.get(failed.source)?.key === failed.key ? failed.message : '';
    error.textContent = failure || [...choices.values()].find((offer) => offer.error)?.error || '';
    error.hidden = !error.textContent;
    if (!dialog.open && !doc.querySelector('dialog[open]')) dialog.showModal();
  }

  function setBusy(busy) {
    dialog.setAttribute('aria-busy', String(busy));
    for (const button of [close, keep, ...Object.values(buttons)]) button.disabled = busy;
  }

  async function choose(source) {
    if (deciding) return;
    const choices = new Map(visible());
    const offer = choices.get(source);
    if (!choices.size || (source !== 'keep' && !offer)) return;
    const operation = deciding = {};
    failed = undefined;
    setBusy(true);
    try {
      if (source === 'keep') await Promise.all([...choices.values()].map((choice) => choice.keep()));
      else if (await offer.resume() && deciding === operation) {
        // Use the exact reading location when both services point to the same
        // place. The Audiobookshelf version can be accepted without a second jump.
        if (source === 'reading' && matching(choices)) await choices.get('audiobookshelf').resume(true);
        if (deciding !== operation) return;
        for (const [other, choice] of choices) if (other !== source) deferred.set(other, choice.key);
      }
    } catch (cause) {
      if (deciding === operation && offer) failed = { source, key: offer.key, message: cause.message };
    } finally {
      if (deciding === operation) {
        deciding = undefined;
        setBusy(false);
        render();
      }
    }
  }

  for (const [source, button] of Object.entries(buttons)) button.addEventListener('click', () => void choose(source));
  keep.addEventListener('click', () => void choose('keep'));
  dialog.addEventListener('cancel', (event) => {
    if (deciding) { event.preventDefault(); return; }
    for (const [source, offer] of visible()) deferred.set(source, offer.key);
  });
  // Wait for any existing reader dialog to close before opening this one.
  doc.addEventListener('close', (event) => { if (event.target !== dialog && offers.size) render(); }, true);

  return {
    refresh: render,
    update(source, offer) {
      if (offer) offers.set(source, offer);
      else { offers.delete(source); deferred.delete(source); }
      render();
    },
    open() {
      if (!offers.size) return false;
      deferred.clear(); render(); return true;
    },
    reset() {
      offers.clear(); deferred.clear(); failed = deciding = undefined;
      setBusy(false); render();
    },
  };
}
