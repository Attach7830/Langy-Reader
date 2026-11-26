import { $, api, element, message } from './ui.js';
import { languageLabel } from './languages.js';
import { baseLanguage } from '../shared/language.js';
import { comprehensionLevels } from '../shared/proficiency.js';
import { proficiencyChart } from './proficiency-chart.js';

const format = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
export function proficiencyPage({ preferences }) {
  const preferenceKey = () => JSON.stringify([preferences().nativeLanguage,preferences().readingLanguages]);
  let clearChart, preferenceRevision, active = false, epoch = 0, result, controller, saving = false;
  const language = $('#proficiency-language'), metric = $('#proficiency-metric'), form = $('#proficiency-form');
  for (const id of ['reading','listening']) $('#proficiency-' + id).replaceChildren(...comprehensionLevels.map((level) => new Option(level.label, level.value)));
  const native = () => baseLanguage(preferences().nativeLanguage, '');
  const allowed = () => (result?.languages || []).filter((item) => baseLanguage(item.language, '') !== native());
  function renderChoices() {
    const previous = language.value, choices = allowed(); language.replaceChildren(...choices.map((item) => new Option(languageLabel(item.language), item.language)));
    if (choices.some((item) => item.language === previous)) language.value = previous;
    $('#proficiency-content').hidden = !choices.length; $('#proficiency-empty').hidden = Boolean(choices.length); render();
  }
  function render() {
    const data = allowed().find((item) => item.language === language.value); if (!data) return;
    $('#proficiency-language-title').textContent = languageLabel(data.language);
    $('#proficiency-known-label').textContent = data.unit === 'characters' ? 'Likely familiar Han characters' : 'Likely familiar lemmas';
    $('#proficiency-seen').textContent = format(data.seen); $('#proficiency-seen-unit').textContent = data.unit === 'characters' ? 'Han characters encountered' : 'lemmas encountered';
    $('#proficiency-known').textContent = format(data.likelyKnown); $('#proficiency-hours').textContent = format(data.totalHours);
    $('#proficiency-books').textContent = format(data.books); $('#proficiency-authors').textContent = `${format(data.authors)} identifiable authors in your current library`;
    $('#proficiency-threshold').textContent = `“Likely familiar” uses your current threshold of ${format(result.threshold)} exposures. This is an exposure proxy, not a vocabulary test.`;
    $('#proficiency-hours-detail').textContent = `${format(data.trackedHours)} active reading hours in Langy + ${format(data.outsideHours)} estimated hours outside Langy.`;
    for (const kind of ['reading','listening']) {
      const estimate = data[kind + 'Estimate']; $('#proficiency-' + kind + '-range').textContent = estimate.range || 'Not estimated yet';
      $('#proficiency-' + kind + '-basis').textContent = estimate.range ? `Tentative ${kind} range · ${estimate.evidence.toLowerCase()}` : 'Choose a comprehension check below to estimate a broad range.';
    }
    $('#proficiency-familiarity').hidden = data.familiarEncounterPercent == null;
    $('#proficiency-familiarity-meter').value = data.familiarEncounterPercent || 0;
    $('#proficiency-familiarity-caption').textContent = `${format(data.familiarEncounterPercent || 0)}% of logged encounters involve vocabulary above your exposure threshold. Frequent vocabulary contributes more to this measure. It estimates familiarity in your recorded reading, rather than comprehension.`;
    $('#proficiency-exposure-note').textContent = `${format(data.exposures)} recorded encounters: ${format(data.trackedExposures)} from reading and ${format(data.completionExposures)} added by books marked read. Repetition and book completion do not prove retention.`;
    $('#proficiency-input-hours').value = data.outsideHours; $('#proficiency-reading').value = data.readingCheck; $('#proficiency-listening').value = data.listeningCheck;
    const kind = metric.value, hours = kind === 'hours';
    const points = kind === 'seen' ? data.history.seen.map((point) => ({ date: point.date, value: point.seen })) : data.history.observations.filter((point) => hours || point.threshold === result.threshold).map((point) => ({ date: point.date, value: point[hours ? 'hours' : 'known'] }));
    const label = hours ? 'Input hours' : kind === 'known' ? `Likely familiar ${data.unit === 'characters' ? 'Han characters' : 'lemmas'}` : `Encountered ${data.unit === 'characters' ? 'Han characters' : 'lemmas'}`;
    $('#proficiency-chart-label').textContent = label; clearChart?.(); clearChart=proficiencyChart($('#proficiency-chart'), points, { label, hours });
    $('#proficiency-chart-note').textContent = kind === 'seen' ? 'Vocabulary history uses recorded first encounters, including books you marked read. Lines connect actual records.' : hours ? 'Input-hour observations begin when you first open this page. Outside hours are your cumulative estimate; edits do not invent an earlier history.' : 'Familiar-vocabulary observations begin on this page. Only observations using your current exposure threshold are shown.';
    const table = $('#proficiency-history'); table.replaceChildren(...points.slice(-30).reverse().map((point) => { const row = document.createElement('tr'); row.append(element('td', '', point.date), element('td', '', format(point.value))); return row; }));
  }
  language.addEventListener('change', () => { message('#proficiency-status'); render(); }); metric.addEventListener('change', render);
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (saving || !result || !allowed().some((item) => item.language === language.value) || !form.reportValidity()) return;
    const visit = epoch, selected = language.value; saving = true; $('#proficiency-save').disabled = true;
    try { const updated = await api('/api/proficiency', { method: 'PUT', body: { accountId: result.accountId, language: selected, hours: Number($('#proficiency-input-hours').value), reading: Number($('#proficiency-reading').value), listening: Number($('#proficiency-listening').value) } }); if (active && epoch === visit) { result = updated; renderChoices(); message('#proficiency-status', 'Input history and comprehension checks saved to your account.'); } }
    catch (error) { if (active && epoch === visit) message('#proficiency-status', error.message); }
    finally { saving = false; $('#proficiency-save').disabled = false; }
  });
  return {
    async open() {
      active = true; preferenceRevision = preferenceKey(); const visit = ++epoch; controller?.abort(); const task = controller = new AbortController();
      // Remove stale graphs immediately when accounts or L1 settings change.
      clearChart?.(); clearChart=undefined; $('#proficiency-chart').replaceChildren(); result = null; language.replaceChildren(); $('#proficiency-content').hidden = true; $('#proficiency-empty').hidden = true;
      message('#proficiency-status', 'Loading your reading history…');
      try { const value = await api('/api/proficiency', { signal: task.signal }); if (active && visit === epoch) { result = value; renderChoices(); message('#proficiency-status'); } }
      catch (error) { if (active && visit === epoch && !task.signal.aborted) message('#proficiency-status', error.message); }
    },
    preferencesChanged() { if (active && preferenceRevision !== preferenceKey()) void this.open(); },
    leave() { clearChart?.(); clearChart=undefined; active = false; epoch++; controller?.abort(); result = null; $('#proficiency-chart').replaceChildren(); },
  };
}
