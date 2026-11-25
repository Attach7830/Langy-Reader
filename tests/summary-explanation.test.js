import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAISettings } from '../server/ai.js';

const page = 'La niña regresó a la casa al caer la tarde. En la puerta encontró a su hermano con una carta en la mano. Él guardó el papel antes de que ella pudiera leerlo y dijo que no había ocurrido nada. La niña recordó entonces la conversación de la mañana y decidió esperar antes de hacer preguntas.';
const earlier = 'Por la mañana, los hermanos habían discutido sobre una deuda que no podían pagar. La niña quería pedir ayuda a su madre, pero su hermano insistió en resolver el problema sin contarle nada a la familia.';
const brief = 'La niña descubre que su hermano oculta una carta. Ella sospecha que está relacionada con el problema del que hablaron por la mañana.';
const explanation = 'El gesto de esconder la carta crea una diferencia entre lo que el hermano afirma y lo que su conducta sugiere. Su negación puede ser una manera de evitar una conversación difícil; todavía no conocemos el contenido de la carta.\n\n'
  + 'La discusión sobre la deuda ayuda a entender la desconfianza de la niña. Ella relaciona ambos momentos, pero decide observar antes de actuar. Esa espera mantiene la tensión del relato y deja abierta la explicación de su silencio.';
const englishPage = 'The girl returned to the house as evening fell. Her brother was standing by the door with a letter in his hand. He put the paper away before she could read it and said that nothing had happened. She remembered their conversation that morning and decided to wait before asking any questions.';
const englishExplanation = 'His attempt to conceal the letter creates tension because his actions conflict with his reassuring words. The reader has a reason to doubt his claim, although the contents of the message remain unknown.\n\nHer decision to wait shows caution and leaves the conflict unresolved.';
const source = (request) => JSON.parse(request.messages[1].content.match(/Source data \(JSON\): ([^\n]+)/u)[1]);

async function fixture(t, respond, provider = 'ollama') {
  const dir = await mkdtemp(join(tmpdir(), 'langy-summary-')), previous = globalThis.fetch, requests = [];
  t.after(async () => { globalThis.fetch = previous; await rm(dir, { recursive: true, force: true }); });
  const ai = await openAISettings(dir, false);
  await ai.save({ provider, baseUrl: 'http://local-ai.test:11434', model: 'qwen3:8b' });
  globalThis.fetch = async (url, options) => {
    const request = JSON.parse(options.body); requests.push({ ...request, url: String(url), signal: options.signal });
    let answer = await respond(request, requests.length);
    const structured = request.messages[1].content.includes('"required":["text","meaning","context"]');
    if (structured && typeof answer === 'string') {
      const [text, ...meaning] = answer.split('\n\n'); answer = { text, meaning: meaning.join(' '), context: '' };
    }
    const content = typeof answer === 'string' && provider === 'openai' ? answer : JSON.stringify(typeof answer === 'string' ? { text: answer } : answer);
    return Response.json(provider === 'openai' ? { choices: [{ message: { content } }] } : { message: { content } });
  };
  const body = { mode: 'deeper', text: page, earlier, brief, language: 'es', book: { title: 'A fictional test story', author: 'Test Author' } };
  return { ai, requests, body, signal: new AbortController().signal };
}

test('Go deeper retries a page transcription, requests an explanation and retains the book, earlier pages and chosen language', async (t) => {
  const { ai, requests, body, signal } = await fixture(t, (_request, n) => n === 1 ? page : explanation);
  const result = await ai.summary(body, signal);
  assert.equal(result.text, explanation); assert.deepEqual(result.sections.map((section) => section.heading), ['Esta página', 'Qué significa']); assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, 'qwen3:8b'); assert.equal(request.think, false);
    assert.equal(request.url, 'http://local-ai.test:11434/api/chat');
    assert.match(request.messages[0].content, /reading tutor/); assert.match(request.messages[0].content, /en español/);
    assert.match(request.messages[0].content, /ONLY THE CURRENT PAGE/);
    assert.match(request.messages[1].content, /No book overview, biography or publication dates/);
    assert.match(request.messages[1].content, /Do not transcribe, translate or continue/);
    const data = source(request);
    assert.equal(data.page, page); assert.equal(data.earlierPages, earlier); assert.equal(data.briefSummary, brief); assert.deepEqual(data.book, { ...body.book, publicationDate: '' });
  }
  assert.match(requests[1].messages[1].content, /last attempt repeated/);
});

test('persistent copying produces a retryable error after exactly one retry', async (t) => {
  const { ai, requests, body, signal } = await fixture(t, () => englishPage);
  await assert.rejects(ai.summary({ ...body, text: englishPage, language: 'en' }, signal), { status: 502, message: /repeated the book text instead of explaining/ });
  assert.equal(requests.length, 2);
});

test('short supporting quotations inside an original explanation are accepted without another generation', async (t) => {
  const answer = `${englishExplanation}\n\nThe phrase “her brother was standing by the door with a letter” establishes where the encounter takes place. It also introduces the object that makes his later concealment significant. This detail helps us understand the conflict without establishing who sent the message or what it says.`;
  const { ai, requests, body, signal } = await fixture(t, () => answer);
  const result = await ai.summary({ ...body, text: englishPage, language: 'en' }, signal);
  assert.match(result.text, /her brother was standing by the door with a letter/); assert.equal(requests.length, 1);
});

test('OpenAI-compatible connections retry copied passages despite changed case and punctuation', async (t) => {
  const { ai, requests, body, signal } = await fixture(t, (_request, n) => n === 1 ? englishPage.toUpperCase().replaceAll('.', '!') : englishExplanation, 'openai');
  assert.equal((await ai.summary({ ...body, text: englishPage, language: 'en' }, signal)).text, englishExplanation);
  assert.equal(requests.length, 2); assert.equal(requests[0].url, 'http://local-ai.test:11434/v1/chat/completions');
  assert.equal(requests[0].max_tokens, 460); assert.equal(requests[0].format, undefined);
});

test('Go deeper adds explanation rather than repeating the brief summary or earlier pages', async (t) => {
  const answers = [brief, explanation, earlier, explanation];
  const { ai, requests, body, signal } = await fixture(t, () => answers.shift());
  assert.equal((await ai.summary(body, signal)).text, explanation);
  assert.equal((await ai.summary(body, signal)).text, explanation);
  assert.equal(requests.length, 4);
});

test('transcriptions are rejected before language correction, and translated copies are checked again', async (t) => {
  const answers = [englishPage, explanation, englishExplanation, page, explanation];
  const { ai, requests, body, signal } = await fixture(t, () => answers.shift());
  assert.equal((await ai.summary({ ...body, text: englishPage }, signal)).text, explanation);
  assert.equal(requests.length, 2, 'a copied English source is regenerated rather than translated');
  assert.equal((await ai.summary(body, signal)).text, explanation);
  assert.equal(requests.length, 5, 'a translation that copied the Spanish source must be regenerated');
  assert.match(requests[3].messages[1].content, /Traduce al español/);
});

test('long-page condensation still rejects copying from the original source', async (t) => {
  let generations = 0;
  const { ai, requests, body, signal } = await fixture(t, (request) => {
    if (request.messages[1].content.includes('Condense this portion')) return 'La visita a la casa introduce un conflicto entre hermanos. El secreto de la carta provoca dudas y hace que la niña prefiera observar.';
    return ++generations === 1 ? page : explanation;
  });
  assert.equal((await ai.summary({ ...body, text: (page + '\n').repeat(24) }, signal)).text, explanation);
  assert.equal(generations, 2); assert.ok(requests.length > 2);
});

test('copy detection supports Mandarin word boundaries', async (t) => {
  const chinese = '女孩傍晚回到家里，看见哥哥站在门口，手里拿着一封信。他把信藏起来，说什么事情都没有发生。女孩想起早上的争论，决定暂时不问。';
  const answer = '哥哥的动作与他说的话并不一致，所以读者会怀疑他有所隐瞒。女孩选择等待，表现出她的谨慎，也让故事中的紧张感继续存在。\n\n目前还不能确定信里写了什么。';
  const { ai, requests, body, signal } = await fixture(t, (_request, n) => n === 1 ? chinese : answer);
  assert.equal((await ai.summary({ ...body, text: chinese, language: 'zh' }, signal)).text, answer); assert.equal(requests.length, 2);
});

test('Go deeper breaks verbose replies into bounded sections and keeps contextual detail optional', async (t) => {
  const { ai, requests, body, signal } = await fixture(t, () => ({
    text: 'She notices the concealed message. Her brother denies any problem. She asks about tomorrow. Another event happens.',
    meaning: 'The concealment creates uncertainty. His denial gives her a reason to doubt him. Waiting keeps the tension unresolved. This fourth sentence should be omitted.',
    context: 'Their earlier disagreement makes her reaction understandable. This additional sentence is unnecessary.',
  }));
  const result = await ai.summary({ ...body, language: 'en' }, signal);
  assert.deepEqual(result.sections, [
    { heading: 'On this page', text: 'She notices the concealed message. Her brother denies any problem.' },
    { heading: 'What it means', text: 'The concealment creates uncertainty. His denial gives her a reason to doubt him. Waiting keeps the tension unresolved.' },
    { heading: 'Useful context', text: 'Their earlier disagreement makes her reaction understandable.' },
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].format.required, ['text', 'meaning', 'context']);
});

test('an incomplete explanation is regenerated once rather than displayed as a page-only block', async (t) => {
  const { ai, requests, body, signal } = await fixture(t, (_request, n) => n === 1 ? { text: 'She doubts what she has been told.' } : explanation);
  const result = await ai.summary(body, signal);
  assert.equal(result.text, explanation); assert.equal(result.sections.length, 2); assert.equal(requests.length, 2);
});

test('brief summaries and suggested questions retain their existing response format', async (t) => {
  const { ai, requests, body, signal } = await fixture(t, (_request, n) => n === 1
    ? { text: 'She returns home. He hides a letter. She waits. An extra sentence.', suggestions: ['Why does she wait?'] } : englishExplanation);
  assert.deepEqual(await ai.summary({ ...body, mode: 'brief', language: 'en' }, signal), { text: 'She returns home. He hides a letter. She waits.', suggestions: ['Why does she wait?'] });
  assert.equal((await ai.summary({ ...body, mode: 'question', question: 'Why does she wait?', language: 'en' }, signal)).text, englishExplanation);
  assert.equal(requests.length, 2); assert.equal(source(requests[1]).question, 'Why does she wait?');
});

test('closing the summary cancels a pending correction without another model request', async (t) => {
  const controller = new AbortController();
  const { ai, requests, body } = await fixture(t, () => { controller.abort(); return page; });
  await assert.rejects(ai.summary(body, controller.signal), { name: 'AbortError' }); assert.equal(requests.length, 1);
});

test('phrase help sends the exact selection and passage, requests the chosen language and rejects oversized or missing context', async (t) => {
  const f = await fixture(t, () => 'Aquí significa que todavía hay asuntos por descubrir.');
  const body = { phrase: 'muchas cosas por descubrir', context: 'Todavía quedaban muchas cosas por descubrir.', language: 'es', translationLanguage: 'pt' };
  assert.equal(await f.ai.phrase(body, f.signal), 'Aquí significa que todavía hay asuntos por descubrir.');
  const request = f.requests[0]; assert.match(request.messages[0].content, /Portuguese/u); assert.match(request.messages[1].content, /two or three short sentences/u);
  assert.equal(source(request).selectedPhrase, body.phrase); assert.equal(source(request).passage, body.context);
  for (const invalid of [{ ...body, phrase: '' }, { ...body, phrase: 'x'.repeat(701) }, { ...body, context: 'unrelated' }, { ...body, context: 'x'.repeat(4001) }]) await assert.rejects(f.ai.phrase(invalid, f.signal), /Select a phrase/u);
  assert.equal(f.requests.length, 1);
});
