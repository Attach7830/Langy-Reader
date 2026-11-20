import { $, api, message } from './ui.js';

export function narrationSettings() {
  const fields = $('#settings-form').elements;
  let config;
  async function load() {
    try {
      config = await api('/api/settings/learning');
      $('#kokoro-settings').hidden = !config.configurable;
      $('#kokoro-managed').hidden = config.configurable;
      $('#kokoro-managed').textContent = config.previewAudio
        ? 'Audio and podcast controls are available to preview. This demo has no Kokoro connection. Connect Kokoro in your self-hosted installation to generate narration.'
        : 'The demo owner manages the narration connection.';
      for (const name of ['baseUrl', 'model', 'voice', 'speed']) fields['kokoro_' + name].value = config[name] ?? '';
      fields.kokoro_apiKey.value = '';
      fields.kokoro_clearKey.checked = false;
      fields.kokoro_apiKey.placeholder = config.hasKey ? 'Saved key · leave blank to keep' : 'Optional';
    } catch (error) { message('#kokoro-result', error.message); }
  }
  async function save() {
    if (!config?.configurable) return;
    const body = {
      baseUrl: fields.kokoro_baseUrl.value, voice: fields.kokoro_voice.value, model: fields.kokoro_model.value,
      speed: Number(fields.kokoro_speed.value), apiKey: fields.kokoro_apiKey.value, clearKey: fields.kokoro_clearKey.checked,
    };
    const changed = ['baseUrl', 'voice', 'model', 'speed'].some((name) => body[name] !== config[name])
      || body.apiKey || body.clearKey;
    if (changed) config = await api('/api/settings/learning', { method: 'PUT', body });
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
  return { load, save, reset() { config = undefined; } };
}
