export async function fetchPackResource(path, signal) {
  let response;
  try { response = await fetch(path, { signal }); }
  catch (error) { if (signal?.aborted || error.name === 'AbortError') throw error; throw Object.assign(new Error('Connection lost. This download will wait for a connection.'), { retryable: true }); }
  if (!response.ok || ['X-Langy-Offline', 'X-Langy-Cached'].some((header) => response.headers.get(header) === '1')) {
    let detail; try { detail = await response.json(); } catch {}
    throw Object.assign(new Error(detail?.error || 'Could not download this reading pack. Reconnect to Langy and retry.'),
      { retryable: response.status >= 500 || [408, 429].includes(response.status) || response.headers.get('X-Langy-Cached') === '1' });
  }
  return response;
}

export function measuredResponse(response, progress, signal) {
  const encoded = response.headers.get('Content-Encoding');
  const length = !encoded || encoded === 'identity' ? Number(response.headers.get('Content-Length')) : 0;
  const total = Number.isFinite(length) && length > 0 ? length : 0;
  let loaded = 0;
  progress({ loaded, total });
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) { controller.close(); progress({ loaded, total, complete: true }); return; }
        loaded += next.value.byteLength; controller.enqueue(next.value); progress({ loaded, total });
      } catch (error) {
        controller.error(signal?.aborted ? error : Object.assign(error, { retryable: true }));
        await reader.cancel(error).catch(() => {});
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function downloadProgressLabel(progress = {}) {
  const bytes = (value) => value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(value / 1024)} KiB`;
  const size = progress.total ? `${bytes(progress.loaded || 0)} / ${bytes(progress.total)}` : progress.loaded ? bytes(progress.loaded) : '';
  return [progress.label, size].filter(Boolean).join(' · ');
}
