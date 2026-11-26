import { Agent, fetch } from 'undici';

// PaddleOCR sends response headers only after the complete PDF is ready. A
// longer AbortSignal does not replace Undici's default five-minute header limit.
export const ocrRequestTimeout = 3_660_000;
export function ocrHTTP({ headersTimeout = ocrRequestTimeout, bodyTimeout = ocrRequestTimeout, connectTimeout = 15_000 } = {}) {
  const dispatcher = new Agent({ headersTimeout, bodyTimeout, connectTimeout, connections: 2 });
  return {
    request: (url, options = {}) => fetch(url, { ...options, dispatcher }),
    close: () => dispatcher.destroy(),
  };
}
