import { kavitaConnection } from './kavita.js';
import { $, $$, api, element, message, toast } from './ui.js';
import { defaults, eventKey, fonts, keyLabel, modes, shortcuts, themes } from './settings.js';
import { languageOptions, parseLanguage } from './languages.js';
import { narrationSettings } from './ui-narration-settings.js';
import { archiveSettings } from './ui-archive-settings.js';
import { deviceSettings } from './ui-device-settings.js';
import { readingLanguagesPicker } from './reading-languages.js';
import { readingFontSize, fontSizeChange, touchReader } from './touch-preferences.js';
import { credentialRemoval } from './credential-removal.js';
import { coverCache } from './cover-cache.js';
import { fontSettings } from './ui-fonts.js';
import { coverSearchSettings } from './ui-cover-settings.js';
import { languageDefaultsEditor } from './ui-language-defaults.js';

export function settingsPage({ preferences, apply, navigate, back, safeMode = false }) {
  const narration = narrationSettings();
  const archive = archiveSettings();
  const kavita = kavitaConnection();
  const covers = coverSearchSettings();
  const devices = deviceSettings();
  $('#clear-cover-cache').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { await coverCache.clear(); message('#cover-cache-status', 'Cached cover images cleared. Covers will load again when needed.'); }
    catch { message('#cover-cache-status', 'Device storage is unavailable.'); }
    finally { event.target.disabled = false; }
  });
  const form = $('#settings-form');
  const fields = form.elements;
  const languageDefaults = languageDefaultsEditor();
  const readingLanguages = readingLanguagesPicker({ host: $('#reading-language-list'), input: $('#reading-language-choice'), add: $('#reading-language-add'), error: (text) => message('#settings-error', text), changed: (values) => languageDefaults.languages(values) });
  const aiTab = $('[data-settings-tab="ai"]');
  if (safeMode) for (const tab of $$('[data-settings-tab][data-full-access]')) tab.hidden = true;
  const themeButtons = Object.entries(themes).map(([value, theme]) => {
    const label = element('label', 'theme-option');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'theme';
    input.value = value;
    input.setAttribute('aria-label', theme.name);
    const swatch = element('span', 'theme-swatch', 'Aa');
    swatch.style.setProperty('--swatch-bg', theme.background);
    swatch.style.setProperty('--swatch-ink', theme.ink);
    label.append(input, swatch, element('span', '', theme.name));
    return label;
  });
  $('#theme-options').append(...themeButtons);
  $('#font-options').append(...Object.entries(fonts).map(([value, { name }]) => new Option(name, value)));
  const importedFonts = fontSettings(form);
  $('#help-options').append(...Object.entries(modes).map(([value, name]) => new Option(value === 'translation' ? 'Translation' : name, value)));
  $('#languages').append(...languageOptions.map(({ code, label }) => new Option(label, code)));
  let shadowKeys = {}, recording, aiConfig, pending = false;
  let canConfigureAI = false;
  let renderingAI = false;
  const removeKey = credentialRemoval({ button: $('#clear-key-field'), input: fields.apiKey, endpoint: '/api/settings/ai/key',
    status: '#settings-error', revision: () => visit, changed(config) { aiConfig = config; updateProvider(); apply(preferences(), true); } });
  let active = false, visit = 0;

  function renderKeys() {
    const rows = Object.entries(shortcuts).map(([name, label]) => {
      const row = element('div', 'shortcut-row');
      const listening = recording === name;
      const button = element('button', 'shortcut-key', listening ? 'Press a key…' : keyLabel(shadowKeys[name]));
      button.type = 'button';
      button.dataset.key = name;
      button.dataset.capturing = String(listening);
      button.setAttribute('aria-label', `${label} hotkey`);
      button.addEventListener('click', () => {
        recording = listening ? undefined : name;
        message('#settings-error');
        renderKeys();
        $(`[data-key="${name}"]`, form)?.focus();
      });
      row.append(element('span', '', label), button);
      return row;
    });
    $('#shortcut-list').replaceChildren(...rows);
  }

  function section(name) {
    $('.settings-actions', form).hidden = name === 'account';
    for (const tab of $$('[data-settings-tab]')) tab.setAttribute('aria-current', String(tab.dataset.settingsTab === name));
    for (const panel of $$('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== name;
    recording = undefined;
    renderKeys();
    message('#settings-error');
  }

  function updateProvider() {
    const external = fields.provider.value !== 'bundled';
    removeKey.refresh(aiConfig);
    $('#ai-url-field').hidden = !external;
    $('#api-key-field').hidden = !external;
    $('#clear-key-field').hidden = !external || !aiConfig?.hasKey;
    fields.baseUrl.placeholder = fields.provider.value === 'openai'
      ? 'http://host.docker.internal:8000/v1' : 'http://host.docker.internal:11434';
    fields.apiKey.placeholder = aiConfig?.hasKey ? 'Saved API key' : 'Optional';
    $('#use-server-ai').hidden = !aiConfig?.canUseServerDefault;
    $('#server-ai-note').hidden = !aiConfig?.inherited;
    if (!external && !fields.aiModel.value) fields.aiModel.value = aiConfig?.bundledModel || '';
    $('#ai-models').replaceChildren();
    message('#model-result');
  }

  async function loadAI() {
    if (renderingAI || aiConfig) return;
    renderingAI = true;
    const epoch = visit;
    try {
      const settings = await api('/api/settings/ai');
      if (!active || epoch !== visit) return;
      aiConfig = settings;
      fields.provider.value = settings.provider;
      fields.baseUrl.value = settings.baseUrl;
      fields.aiModel.value = settings.model;
      updateProvider();
    } catch (error) { message('#settings-error', error.message); }
    finally { if (epoch === visit) renderingAI = false; }
  }

  function aiDraft() {
    return {
      provider: fields.provider.value,
      baseUrl: fields.provider.value === 'bundled' ? '' : fields.baseUrl.value.trim().replace(/\/+$/u, ''),
      model: fields.aiModel.value.trim(), apiKey: fields.apiKey.value,
    };
  }

  $('#use-server-ai').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { aiConfig = await api('/api/settings/ai/override', { method: 'DELETE' }); fields.provider.value = aiConfig.provider; fields.baseUrl.value = aiConfig.baseUrl; fields.aiModel.value = aiConfig.model; fields.apiKey.value = ''; updateProvider(); }
    catch (error) { message('#model-result', error.message); }
    finally { event.target.disabled = false; }
  });

  function open(tab) {
    if (pending) { active = true; return; }
    const allowed = $$('[data-settings-tab]').filter((button) => !button.hidden).map((button) => button.dataset.settingsTab);
    if (!allowed.includes(tab)) tab = 'reading';
    if (active) { select(tab); return; }
    active = true; visit++; renderingAI = false;
    form.reset();
    narration.reset();
    archive.reset(); covers.reset(); kavita.reset();
    devices.reset();
    aiConfig = null;
    const current = preferences();
    readingLanguages.set(current.readingLanguages);
    languageDefaults.set(current);
    for (const key of ['mode', 'summaryLanguage', 'translationLanguage', 'theme', 'background', 'font', 'size', 'line', 'width', 'uiLanguage', 'nativeLanguage']) {
      fields[key].value = current[key];
    }
    fields.autoHideDocks.checked = current.autoHideDocks;
    importedFonts.select(current.font);
    for (const key of ['doubleTapToTurn', 'swipeToTurn', 'tapCenterFullscreen']) fields[key].checked = current[key] ?? defaults[key];
    fields.size.value = readingFontSize(current);
    $('#font-size-device-note').textContent = touchReader() ? 'Phone/tablet text size. Desktop text size is saved separately.' : 'Desktop text size. Phone/tablet text size is saved separately.';
    fields.immersionMode.checked = current.immersionMode;
    fields.quietLibrary.checked = current.quietLibrary;
    fields.pdfNight.checked = current.pdfNight;
    fields.synonymContextHelp.checked = current.synonymContextHelp;
    fields.showPinyin.checked = current.showPinyin;
    fields.cacheAI.checked = current.cacheAI !== false;
    fields.cacheCovers.checked = current.cacheCovers !== false;
    fields.audioHighlight.checked = current.audioHighlight;
    fields.progressSyncEnabled.checked = current.progressSyncEnabled;
    fields.syncDeviceName.value = current.syncDeviceName;
    shadowKeys = { ...current.keys };
    select(tab);
  }

  function select(tab) {
    section(tab);
    if (tab === 'reading') void importedFonts.load(preferences().font);
    if (tab === 'ai') void loadAI();
    if (tab === 'narration') void narration.load();
    if (tab === 'sources') {void archive.load();void covers.load();void kavita.load();}
    if (tab === 'devices') void devices.load();
  }

  for (const tab of $$('[data-settings-tab]')) tab.addEventListener('click', () => {
    navigate(tab.dataset.settingsTab);
  });
  for (const button of $$('[data-settings]')) button.addEventListener('click', () => navigate(button.dataset.settings));
  for (const button of $$('[data-settings-back]')) button.addEventListener('click', () => { if (!pending) back(); });

  document.addEventListener('keydown', (event) => {
    if (!active || !recording) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = recording;
    if (event.key === 'Escape') recording = undefined;
    else {
      const key = event.key === 'Backspace' ? '' : eventKey(event);
      if (!key && event.key !== 'Backspace') return;
      if (key && Object.entries(shadowKeys).some(([action, shortcut]) => action !== name && shortcut === key)) {
        message('#settings-error', 'That key is already assigned. Choose another key or clear its current assignment.');
        return;
      }
      shadowKeys[name] = key;
      recording = undefined;
    }
    message('#settings-error');
    renderKeys();
    $(`[data-key="${name}"]`, form)?.focus();
  }, true);

  $('#reset-shortcuts').addEventListener('click', () => {
    shadowKeys = { ...defaults.keys };
    recording = undefined;
    message('#settings-error');
    renderKeys();
  });
  fields.provider.addEventListener('change', () => {
    fields.aiModel.value = fields.provider.value === aiConfig?.provider ? aiConfig.model : '';
    fields.apiKey.value = '';
    updateProvider();
  });
  $('#load-models').addEventListener('click', async () => {
    const button = $('#load-models');
    button.disabled = true;
    message('#model-result', 'Checking endpoint…');
    try {
      const { models } = await api('/api/settings/ai/models', { method: 'POST', body: aiDraft() });
      $('#ai-models').replaceChildren(...models.map((model) => new Option(model, model)));
      if (models.length && !models.includes(fields.aiModel.value)) fields.aiModel.value = models[0];
      message('#model-result', models.length
        ? `${models.length} ${models.length === 1 ? 'model' : 'models'} available. Choose one in the Model field.`
        : 'The server returned no models.');
    } catch (error) { message('#model-result', error.message); }
    finally { button.disabled = false; }
  });

  form.noValidate = true;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    for (const name of ['size', 'line']) {
      if (!fields[name].checkValidity()) {
        section('reading');
        return fields[name].reportValidity();
      }
    }
    const summaryLanguage = parseLanguage(fields.summaryLanguage.value);
    const translationLanguage = parseLanguage(fields.translationLanguage.value);
    const nativeLanguage = fields.nativeLanguage.value.trim() ? parseLanguage(fields.nativeLanguage.value) : '';
    let preferredLanguages, outputDefaults;
    try { preferredLanguages = readingLanguages.value(); outputDefaults = languageDefaults.value(); } catch (error) { section('language'); return message('#settings-error', error.message); }
    if (!summaryLanguage || !translationLanguage || fields.nativeLanguage.value.trim() && !nativeLanguage) {
      section('language');
      return message('#settings-error', 'Choose a summary and translation language or enter valid language codes.');
    }

    const updated = {
      mode: fields.mode.value, summaryLanguage, translationLanguage, nativeLanguage, uiLanguage: fields.uiLanguage.value, theme: fields.theme.value,
      readingLanguages: preferredLanguages,
      ...outputDefaults,
      synonymContextHelp: fields.synonymContextHelp.checked,
      showPinyin: fields.showPinyin.checked,
      cacheAI: fields.cacheAI.checked,
      cacheCovers: fields.cacheCovers.checked,
      audioRecordings: preferences().audioRecordings || {},
      audioHighlight: fields.audioHighlight.checked,
      progressSyncEnabled: fields.progressSyncEnabled.checked,
      syncDeviceName: fields.syncDeviceName.value.trim() || 'Langy browser',
      background: fields.background.value, font: fields.font.value, width: fields.width.value,
      ...fontSizeChange(fields.size.valueAsNumber), line: fields.line.valueAsNumber,
      autoHideDocks: fields.autoHideDocks.checked,
      doubleTapToTurn: fields.doubleTapToTurn.checked, swipeToTurn: fields.swipeToTurn.checked, tapCenterFullscreen: fields.tapCenterFullscreen.checked,
      immersionMode: fields.immersionMode.checked, quietLibrary: fields.quietLibrary.checked,
      pdfNight: fields.pdfNight.checked, keys: { ...shadowKeys },
    };
    const saveVisit = visit;
    pending = true; form.inert = true;
    const saveButton = $('button[type="submit"]', form);
    saveButton.disabled = true;
    const draft = aiDraft();
    let aiChanged = false;
    let saveSection = 'narration';
    try {
      await narration.save();
      saveSection = 'sources';
      await archive.save(); await covers.save();
      saveSection = 'devices';
      await devices.save();
      saveSection = 'ai';
      if (canConfigureAI && aiConfig && (draft.provider !== aiConfig.provider || draft.baseUrl !== aiConfig.baseUrl
        || draft.model !== aiConfig.model || draft.apiKey)) {
        aiConfig = await api('/api/settings/ai', { method: 'PUT', body: draft });
        aiChanged = true;
      }
    } catch (error) {
      section(saveSection);
      return message('#settings-error', error.message);
    } finally {
      pending = false; form.inert = false;
      saveButton.disabled = false;
    }
    apply(updated, aiChanged);
    toast('Settings saved');
    if (active && saveVisit === visit) back();
  });

  $('#clear-ai-cache').addEventListener('click', async () => {
    const button = $('#clear-ai-cache'); button.disabled = true;
    try {
      await api('/api/settings/ai-cache', { method: 'DELETE' });
      window.dispatchEvent(new CustomEvent('langy-ai-cache-cleared'));
      message('#ai-cache-status', 'Saved AI answers cleared. New requests may use tokens.');
    } catch (error) { message('#ai-cache-status', error.message); }
    finally { button.disabled = false; }
  });

  return {
    open,
    leave() { active = false; visit++; recording = undefined; },
    get active() { return active; },
    setDemo(demo) {
      canConfigureAI = !demo && !safeMode;
      aiTab.hidden = demo || safeMode;
    },
  };
}
