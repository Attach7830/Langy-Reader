export const touchReader = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
export const readingFontSize = (settings, touch = touchReader()) => touch && Number.isFinite(settings.touchSize) ? settings.touchSize : settings.size;
export const readingPreferences = (settings, touch = touchReader()) => ({ ...settings, size: readingFontSize(settings, touch) });
export const fontSizeChange = (value, touch = touchReader()) => ({ [touch ? 'touchSize' : 'size']: Math.max(13, Math.min(40, Math.round(value))) });
