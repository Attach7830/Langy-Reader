import { RequestError, normalizeLanguage } from './books.js';
import { searchBook } from '../shared/book-search.js';

export function bookTools({ learning, ai }) {
  function search(book, query) {
    if (typeof query !== 'string' || !query.trim() || query.length > 120) throw new RequestError(422, 'Enter a word or phrase of up to 120 characters.');
    const results = searchBook(learning.textSections(book, { original: true }), query, 101);
    return { results: results.slice(0, 100), more: results.length > 100 };
  }
  async function guide(book, body, signal) {
    const language = normalizeLanguage(body.language), sections = learning.textSections(book);
    const index = sections.findIndex((part) => part.key === body.key), current = sections[index];
    if (!language || !current || !Number.isInteger(body.through) || body.through < 0 || body.through > current.text.length
      || typeof (body.query || '') !== 'string' || (body.query || '').length > 100) throw new RequestError(422, 'Choose a current reading position and guide language.');
    // Crop the current source section BEFORE selecting any context. Nothing from
    // an unread page or later chapter reaches the model, even within one spine.
    const reached = sections.slice(0, index + 1).map((part, n) => ({ key: part.key, title: part.title, text: n === index ? part.text.slice(0, body.through) : part.text }));
    const query = (body.query || '').trim();
    const recent = reached.flatMap((part) => part.text ? [{ key: part.key, text: part.text.slice(-5000) }] : []).slice(-3);
    const matches = query ? searchBook(reached, query, 12).map((hit) => ({ key: hit.key, text: hit.before + hit.match + hit.after })) : [];
    const passages = [...matches, ...recent];
    if (!passages.length) throw new RequestError(422, 'This page needs selectable text for a character guide.');
    return { text: await ai.characterGuide({ query, passages, language }, signal), through: { key: body.key, offset: body.through } };
  }
  async function question(book, body, signal) {
    const language = normalizeLanguage(body.language), sections = learning.textSections(book), index = sections.findIndex((part) => part.key === body.key), current = sections[index];
    if (!language || !current || !['page', 'book'].includes(body.scope) || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 1000
      || !Number.isInteger(body.from) || !Number.isInteger(body.through) || body.from < 0 || body.through <= body.from || body.through > current.text.length) throw new RequestError(422, 'Enter a question and choose a valid current reading position.');
    const reached = sections.slice(0, index + 1).map((part, n) => ({ ...part, text: n === index ? part.text.slice(0, body.through) : part.text }));
    const page = current.text.slice(body.from, body.through).slice(0, 16000), earlier = [];
    if (body.scope === 'book') {
      const terms = [...new Set(body.question.match(/[\p{L}\p{M}]{3,}/gu) || [])].slice(0, 16);
      for (const term of terms) earlier.push(...searchBook(reached, term, 3).map((hit) => ({ key: hit.key, text: hit.before + hit.match + hit.after })));
      earlier.push(...reached.slice(-3).map((part) => ({ key: part.key, text: part.text.slice(-2500) })));
    }
    return { text: await ai.bookQuestion({ question: body.question.trim(), scope: body.scope, page, earlier, language }, signal) };
  }
  return { search, guide, question };
}
