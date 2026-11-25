import { $, api, message } from './ui.js';
import { credentialRemoval } from './credential-removal.js';

export function narrationSettings() {
  const fields = $('#settings-form').elements;
  let config, loading = false, epoch = 0;
  const removeKey = credentialRemoval({ button: $('#kokoro-remove-key'), input: fields.kokoro_apiKey, endpoint: '/api/settings/learning/key',
    status: '#kokoro-result', revision: () => epoch, changed(next) { config = next; fields.kokoro_apiKey.placeholder = 'Optional'; } });
  async function load() {
    if (config || loading) return;
    const current = epoch; loading = true;
    try {
      const next = await api('/api/settings/learning');
      if (current !== epoch) return; config = next;
      $('#kokoro-settings').hidden = !config.configurable;
      $('#kokoro-managed').hidden = config.configurable;
      $('#kokoro-managed').textContent = config.previewAudio
        ? 'Audio and podcast controls are available to preview. This demo has no Kokoro connection. Connect Kokoro in your self-hosted installation to generate narration.'
        : config.managed ? 'Your administrator manages the narration connection. You can generate audio for books in your own library.' : 'The demo owner manages the narration connection.';
      for (const name of ['baseUrl', 'model', 'voice', 'speed']) fields['kokoro_' + name].value = config[name] ?? '';
      fields.kokoro_autoLanguages.checked = config.autoLanguageVoices !== false;
      for (const language of ['en', 'es', 'zh', 'pt']) fields['kokoro_voice_' + language].value = config.voicesByLanguage?.[language] || '';
      fields.kokoro_apiKey.value = '';
      removeKey.refresh(config);
      fields.kokoro_apiKey.placeholder = config.hasKey ? 'Saved key · leave blank to keep' : 'Optional';
    } catch (error) { if (current === epoch) message('#kokoro-result', error.message); }
    finally { if (current === epoch) loading = false; }
  }
  async function save() {
    if (!config?.configurable) return;
    const body = {
      baseUrl: fields.kokoro_baseUrl.value, voice: fields.kokoro_voice.value, model: fields.kokoro_model.value,
      speed: Number(fields.kokoro_speed.value), apiKey: fields.kokoro_apiKey.value,
      autoLanguageVoices: fields.kokoro_autoLanguages.checked,
      voicesByLanguage: Object.fromEntries(Object.entries({ ...config.voicesByLanguage, ...Object.fromEntries(['en', 'es', 'zh', 'pt'].map((language) => [language, fields['kokoro_voice_' + language].value.trim()])) }).filter(([, value]) => value)),
    };
    const changed = ['baseUrl', 'voice', 'model', 'speed'].some((name) => body[name] !== config[name])
      || body.autoLanguageVoices !== config.autoLanguageVoices || JSON.stringify(body.voicesByLanguage) !== JSON.stringify(config.voicesByLanguage) || body.apiKey;
    if (changed) { config = await api('/api/settings/learning', { method: 'PUT', body }); removeKey.refresh(config); }
  }
  $('#kokoro-voices').addEventListener('click', async (event) => {
    event.target.disabled = true;
    message('#kokoro-result', 'Checking Kokoro…');
    try {
      await save();
      const { voices } = await api('/api/settings/learning/voices', { method: 'POST', body: {} });
      $('#narration-voices').replaceChildren(...voices.map((voice) => new Option(voice, voice)));
      message('#kokoro-result', `Connected · ${voices.length} voices available`);
    } catch (error) { message('#kokoro-result', error.message); }
    finally { event.target.disabled = false; }
  });
  return { load, save, reset() { epoch++; config = undefined; loading = false; removeKey.refresh(null); } };
}
