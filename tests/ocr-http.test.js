import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ocrHTTP } from '../server/ocr-http.js';

async function endpoint(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('OCR can wait for delayed PDF headers beyond a shorter HTTP header limit', async (t) => {
  const source = Buffer.from('%PDF synthetic upload'), output = Buffer.from('%PDF synthetic searchable result');
  const url = await endpoint(t, async (request, response) => {
    const parts = []; for await (const part of request) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), source);
    await delay(1800); response.writeHead(200, { 'Content-Type': 'application/pdf' }); response.end(output);
  });
  const limited = ocrHTTP({ headersTimeout: 100 }), production = ocrHTTP();
  t.after(() => Promise.all([limited.close(), production.close()]));
  const options = () => ({ method: 'POST', duplex: 'half', body: Readable.from([source]), signal: AbortSignal.timeout(5000) });
  await Promise.all([
    assert.rejects(limited.request(url, options()), (error) => error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT'),
    (async () => {
      const response = await production.request(url, options());
      assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), output);
    })(),
  ]);
});

test('OCR cancellation interrupts both a header wait and a partial PDF response', async (t) => {
  const requests = new Map(), url = await endpoint(t, (request, response) => {
    if (request.url === '/body') { response.writeHead(200); response.write('%PDF partial'); }
    requests.get(request.url)?.();
  });
  const transport = ocrHTTP(); t.after(() => transport.close());
  const headerController = new AbortController();
  const receivedHeadersRequest = new Promise((resolve) => requests.set('/headers', resolve));
  const waiting = transport.request(url + '/headers', { signal: headerController.signal });
  await receivedHeadersRequest; headerController.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const bodyController = new AbortController(), response = await transport.request(url + '/body', { signal: bodyController.signal });
  const bytes = response.arrayBuffer(); bodyController.abort();
  await assert.rejects(bytes, { name: 'AbortError' });
});

test('OCR redirect rejection never forwards the private service key to another endpoint', async (t) => {
  let redirected = 0;
  const target = await endpoint(t, (_request, response) => { redirected++; response.end('unexpected'); });
  const source = await endpoint(t, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-ocr-key');
    response.writeHead(302, { Location: target }); response.end();
  });
  const transport = ocrHTTP(); t.after(() => transport.close());
  await assert.rejects(transport.request(source, { redirect: 'error', headers: { Authorization: 'Bearer synthetic-ocr-key' } }));
  assert.equal(redirected, 0);
});
