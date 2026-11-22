// The supported KOReader XPointer subset is walked as data, never evaluated as
// XPath/JavaScript. Offsets are Unicode codepoints, not UTF-16 code units.
const attribute = 'data-langy-sync-path';
const name = (node) => (node.localName || node.nodeName?.split(':').at(-1) || '').toLowerCase();
const children = (node) => Array.from(node.childNodes || []);
const elements = (node) => children(node).filter((item) => item.nodeType === 1);
const textNodes = (node) => children(node).filter((item) => [3, 4].includes(item.nodeType) && item.data.length);
const nonVisible = new Set(['head', 'style', 'script', 'title', 'rp']);

export function annotateSyncPaths(body, spine) {
  function visit(node, path) {
    node.setAttribute(attribute, path);
    const counts = new Map();
    for (const child of elements(node)) {
      const tag = name(child), index = (counts.get(tag) || 0) + 1;
      counts.set(tag, index);
      visit(child, `${path}/${tag}[${index}]`);
    }
  }
  visit(body, `/body/DocFragment[${spine + 1}]/body`);
}

function elementPath(body, node, spine) {
  const marked = node.getAttribute?.(attribute);
  if (marked) return marked;
  const path = [];
  while (node && node !== body) {
    const parent = node.parentNode;
    if (!parent || node.nodeType !== 1) return null;
    path.unshift(`${name(node)}[${elements(parent).filter((child) => name(child) === name(node)).indexOf(node) + 1}]`);
    node = parent;
  }
  return node === body ? `/body/DocFragment[${spine + 1}]/body${path.length ? '/' + path.join('/') : ''}` : null;
}

export function koReaderXPath(body, node, offset, spine) {
  if ([3, 4].includes(node?.nodeType)) {
    const path = elementPath(body, node.parentNode, spine);
    const index = textNodes(node.parentNode).indexOf(node) + 1;
    if (!path || !index) return null;
    return `${path}/text()[${index}].${[...node.data.slice(0, offset)].length}`;
  }
  return node?.nodeType === 1 ? elementPath(body, node, spine) : null;
}

export function parseKOReaderXPath(path) {
  if (typeof path !== 'string' || path.length > 4096) return null;
  const root = /^\/body\/DocFragment\[([1-9]\d{0,5})\](?:\/body)?(.*)$/u.exec(path);
  if (!root) return null;
  let rest = root[2];
  if (!rest || rest === '.0') return { spine: Number(root[1]) - 1, steps: [], text: null, offset: 0 };
  const text = /\/text\(\)(?:\[([1-9]\d{0,6})\])?(?:\.(\d{1,10}))?$/u.exec(rest);
  if (text) rest = rest.slice(0, text.index);
  else if (rest.endsWith('.0')) rest = rest.slice(0, -2);
  if (rest && (!rest.startsWith('/') || rest.includes('//') || rest.endsWith('/'))) return null;
  const steps = [];
  for (const part of rest.split('/').filter(Boolean)) {
    const step = /^([a-zA-Z_][\w:-]*)(?:\[([1-9]\d{0,6})\])?$/u.exec(part);
    if (!step || steps.length >= 64) return null;
    steps.push({ tag: step[1].split(':').at(-1).toLowerCase(), index: Number(step[2] || 1) });
  }
  return { spine: Number(root[1]) - 1, steps, text: text ? Number(text[1] || 1) : null, offset: Number(text?.[2] || 0) };
}

export function resolveKOReaderXPath(body, path) {
  const parsed = parseKOReaderXPath(path);
  if (!parsed) return null;
  const expected = `/body/DocFragment[${parsed.spine + 1}]/body` + parsed.steps.map((step) => `/${step.tag}[${step.index}]`).join('');
  let node = body;
  // Source paths survive sanitization of scripts/forms and iframe serialization.
  if (body.getAttribute?.(attribute)) {
    const pending = [body];
    node = null;
    while (pending.length) {
      const item = pending.pop();
      if (item.getAttribute(attribute) === expected) { node = item; break; }
      pending.push(...elements(item));
    }
  } else {
    for (const step of parsed.steps) {
      node = elements(node).filter((child) => name(child) === step.tag)[step.index - 1];
      if (!node) return null;
    }
  }
  if (!node) return null;
  if (parsed.text == null) return { node, offset: 0, exact: true };
  const text = textNodes(node)[parsed.text - 1];
  if (!text) return null;
  const points = [...text.data];
  if (parsed.offset > points.length) return null;
  return { node: text, offset: points.slice(0, parsed.offset).join('').length, exact: true };
}

function visibleRuns(body) {
  const runs = [];
  function visit(node) {
    if ([3, 4].includes(node.nodeType)) { runs.push(node); return; }
    if (node.nodeType !== 1 || nonVisible.has(name(node))) return;
    for (const child of children(node)) visit(child);
  }
  visit(body);
  return runs;
}

export function positionFraction(body, node, offset) {
  let total = 0, before = 0, found = false;
  function visit(item) {
    if (item.nodeType === 1 && nonVisible.has(name(item))) return;
    if (item === node) {
      // An element Range points between its children; a text Range uses UTF-16.
      before = total + ([3, 4].includes(item.nodeType) ? [...item.data.slice(0, offset)].length
        : children(item).slice(0, offset).reduce((sum, child) => sum + visibleRuns(child).reduce((n, run) => n + [...run.data].length, 0), 0));
      found = true;
    }
    if ([3, 4].includes(item.nodeType)) total += [...item.data].length;
    else for (const child of children(item)) visit(child);
  }
  visit(body);
  return found && total ? before / total : 0;
}

export function pointAtFraction(body, fraction) {
  const runs = visibleRuns(body);
  const total = runs.reduce((sum, node) => sum + [...node.data].length, 0);
  let remaining = Math.floor(Math.max(0, Math.min(1, fraction)) * total);
  for (const node of runs) {
    const points = [...node.data];
    if (remaining < points.length && node.data.trim()) return { node, offset: points.slice(0, remaining).join('').length, exact: false };
    remaining -= points.length;
    if (remaining < 0) remaining = 0;
  }
  const node = runs.findLast((item) => item.data.trim());
  return node ? { node, offset: node.data.length, exact: false } : { node: body, offset: 0, exact: false };
}

export function weightedPercentage(sizes, spine, fraction) {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (!total || !Number.isInteger(spine) || spine < 0 || spine >= sizes.length) return 0;
  return Math.max(0, Math.min(1, (sizes.slice(0, spine).reduce((a, b) => a + b, 0) + sizes[spine] * fraction) / total));
}

export function percentagePosition(sizes, percentage) {
  const total = sizes.reduce((a, b) => a + b, 0);
  let left = total * Math.max(0, Math.min(1, percentage));
  for (let spine = 0; spine < sizes.length; spine++) {
    if (left < sizes[spine] || spine === sizes.length - 1) return { spine, fraction: sizes[spine] ? left / sizes[spine] : 0 };
    left -= sizes[spine];
  }
  return { spine: 0, fraction: 0 };
}
