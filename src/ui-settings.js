import { $, $$, api, element, message, toast } from './ui.js';
import { defaults, eventKey, fonts, keyLabel, modes, shortcuts, themes } from './settings.js';
import { languageOptions, parseLanguage } from './languages.js';
import { narrationSettings } from './ui-narration-settings.js';
import { archiveSettings } from './ui-archive-settings.js';
import { deviceSettings } from './ui-device-settings.js';
import { readingLanguagesPicker } from './reading-languages.js';

export function settingsDialog({ preferences, apply }) {
  const narration = narrationSettings();
  const archive = archiveSettings();
  const devices = deviceSettings();
  const dialog = $('#settings');
  const form = $('#settings-form');
  const fields = form.elements;
  const readingLanguages = readingLanguagesPicker({ host: $('#reading-language-list'), input: $('#reading-language-choice'), add: $('#reading-language-add'), error: (text) => message('#settings-error', text) });
  const aiTab = $('[data-settings-tab="ai"]');
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
  $('#help-options').append(...Object.entries(modes).map(([value, name]) => new Option(value === 'translation' ? 'Translation' : name, value)));
  $('#languages').append(...languageOptions.map(({ code, label }) => new Option(label, code)));
  let shadowKeys = {}, recording, aiConfig, pending = false;
  let canConfigureAI = false;
  let renderingAI = false;

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
    for (const tab of $$('[data-settings-tab]')) tab.setAttribute('aria-current', String(tab.dataset.settingsTab === name));
    for (const panel of $$('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== name;
    recording = undefined;
    renderKeys();
    message('#settings-error');
  }

  function updateProvider() {
    const external = fields.provider.value !== 'bundled';
    $('#ai-url-field').hidden = !external;
    $('#api-key-field').hidden = !external;
    $('#clear-key-field').hidden = !external || !aiConfig?.hasKey;
    fields.baseUrl.placeholder = fields.provider.value === 'openai'
      ? 'http://host.docker.internal:8000/v1' : 'http://host.docker.internal:11434';
    fields.apiKey.placeholder = aiConfig?.hasKey ? 'Saved API key' : 'Optional';
    if (!external && !fields.aiModel.value) fields.aiModel.value = aiConfig?.bundledModel || '';
    $('#ai-models').replaceChildren();
    message('#model-result');
  }

  async function loadAI() {
    if (renderingAI || aiConfig) return;
    renderingAI = true;
    try {
      const settings = await api('/api/settings/ai');
      if (!dialog.open) return;
      aiConfig = settings;
      fields.provider.value = settings.provider;
      fields.baseUrl.value = settings.baseUrl;
      fields.aiModel.value = settings.model;
      updateProvider();
    } catch (error) { message('#settings-error', error.message); }
    finally { renderingAI = false; }
  }

  function aiDraft() {
    return {
      provider: fields.provider.value,
      baseUrl: fields.provider.value === 'bundled' ? '' : fields.baseUrl.value.trim().replace(/\/+$/u, ''),
      model: fields.aiModel.value.trim(), apiKey: fields.apiKey.value, clearKey: fields.clearKey.checked,
    };
  }

  function open(tab) {
    if (dialog.open) return;
    form.reset();
    narration.reset();
    archive.reset();
    devices.reset();
    aiConfig = null;
    const current = preferences();
    readingLanguages.set(current.readingLanguages);
    for (const key of ['mode', 'summaryLanguage', 'translationLanguage', 'theme', 'background', 'font', 'size', 'line', 'width', 'uiLanguage', 'nativeLanguage']) {
      fields[key].value = current[key];
    }
    fields.autoHideDocks.checked = current.autoHideDocks;
    fields.immersionMode.checked = current.immersionMode;
    fields.quietLibrary.checked = current.quietLibrary;
    fields.pdfNight.checked = current.pdfNight;
    fields.synonymContextHelp.checked = current.synonymContextHelp;
    fields.showPinyin.checked = current.showPinyin;
    fields.audioHighlight.checked = current.audioHighlight;
    fields.progressSyncEnabled.checked = current.progressSyncEnabled;
    fields.syncDeviceName.value = current.syncDeviceName;
    shadowKeys = { ...current.keys };
    section(tab);
    dialog.showModal();
    if (tab === 'ai') void loadAI();
    if (tab === 'narration') void narration.load();
    if (tab === 'sources') void archive.load();
    if (tab === 'devices') void devices.load();
  }

  for (const tab of $$('[data-settings-tab]')) tab.addEventListener('click', () => {
    section(tab.dataset.settingsTab);
    if (tab === aiTab) void loadAI();
    if (tab.dataset.settingsTab === 'narration') void narration.load();
    if (tab.dataset.settingsTab === 'sources') void archive.load();
    if (tab.dataset.settingsTab === 'devices') void devices.load();
  });
  for (const button of $$('[data-settings]')) button.addEventListener('click', () => open(button.dataset.settings));

  document.addEventListener('keydown', (event) => {
    if (!dialog.open || !recording) return;
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
    fields.clearKey.checked = false;
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

  dialog.addEventListener('cancel', (event) => { if (pending) event.preventDefault(); });
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
    let preferredLanguages;
    try { preferredLanguages = readingLanguages.value(); } catch (error) { section('language'); return message('#settings-error', error.message); }
    if (!summaryLanguage || !translationLanguage || fields.nativeLanguage.value.trim() && !nativeLanguage) {
      section('language');
      return message('#settings-error', 'Choose a summary and translation language or enter valid language codes.');
    }

    pending = true;
    const saveButton = $('button[type="submit"]', form);
    saveButton.disabled = true;
    const draft = aiDraft();
    let aiChanged = false;
    let saveSection = 'narration';
    try {
      await narration.save();
      saveSection = 'sources';
      await archive.save();
      saveSection = 'ai';
      if (canConfigureAI && aiConfig && (draft.provider !== aiConfig.provider || draft.baseUrl !== aiConfig.baseUrl
        || draft.model !== aiConfig.model || draft.apiKey || draft.clearKey)) {
        aiConfig = await api('/api/settings/ai', { method: 'PUT', body: draft });
        aiChanged = true;
      }
    } catch (error) {
      section(saveSection);
      return message('#settings-error', error.message);
    } finally {
      pending = false;
      saveButton.disabled = false;
    }
    const updated = {
      mode: fields.mode.value, summaryLanguage, translationLanguage, nativeLanguage, uiLanguage: fields.uiLanguage.value, theme: fields.theme.value,
      readingLanguages: preferredLanguages,
      synonymContextHelp: fields.synonymContextHelp.checked,
      showPinyin: fields.showPinyin.checked,
      audioRecordings: preferences().audioRecordings || {},
      audioHighlight: fields.audioHighlight.checked,
      progressSyncEnabled: fields.progressSyncEnabled.checked,
      syncDeviceName: fields.syncDeviceName.value.trim() || 'Langy browser',
      background: fields.background.value, font: fields.font.value, width: fields.width.value,
      size: fields.size.valueAsNumber, line: fields.line.valueAsNumber,
      autoHideDocks: fields.autoHideDocks.checked,
      immersionMode: fields.immersionMode.checked, quietLibrary: fields.quietLibrary.checked,
      pdfNight: fields.pdfNight.checked, keys: { ...shadowKeys },
    };
    dialog.close();
    apply(updated, aiChanged);
    toast('Settings saved');
  });

  return {
    setDemo(demo) {
      canConfigureAI = !demo;
      aiTab.hidden = demo;
    },
  };
}
