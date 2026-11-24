export function rangeBounds(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header || '');
  if (!match || !match[1] && !match[2]) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size ? { start, end } : null;
}
export async function cachedRange(response, header) {
  if (!header) return response;
  const size = Number(response.headers.get('Content-Length')) || (await response.clone().blob()).size;
  const range = rangeBounds(header, size);
  if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const reader = response.body.getReader(); let offset = 0;
  const body = new ReadableStream({ async pull(controller) {
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) { controller.close(); return; }
        const first = Math.max(0, range.start - offset), last = Math.min(value.length, range.end + 1 - offset); offset += value.length;
        if (last > first) controller.enqueue(value.subarray(first, last));
        if (offset > range.end) { await reader.cancel(); controller.close(); return; }
        if (last > first) return;
      }
    } catch (error) { controller.error(error); }
  }, cancel: () => reader.cancel() });
  const headers = new Headers(response.headers); headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  headers.set('Content-Length', String(range.end - range.start + 1)); headers.set('Accept-Ranges', 'bytes');
  return new Response(body, { status: 206, headers });
}
