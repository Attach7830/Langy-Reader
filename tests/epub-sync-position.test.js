import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { annotateSyncPaths, koReaderXPath, parseKOReaderXPath, resolveKOReaderXPath,
  positionFraction, pointAtFraction, weightedPercentage, percentagePosition } from '../shared/epub-sync-position.js';

function body(xml) {
  return new DOMParser().parseFromString(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${xml}</body></html>`, 'application/xhtml+xml').getElementsByTagName('body')[0];
}

test('portable EPUB positions round-trip nested Spanish text, repeated tags, and Unicode codepoint offsets', () => {
  const root = body('<div><p>Primero</p><p>¿Qué 🙂 tal? <em>árbol</em> después<!-- split -->fin</p></div><div><p>Otro</p></div>');
  const paragraph = root.firstChild.childNodes[1];
  const word = paragraph.firstChild;
  const offset = word.data.indexOf(' tal');
  assert.equal(offset, 7); // UTF-16 includes both halves of the emoji.
  const path = koReaderXPath(root, word, offset, 2);
  assert.equal(path, '/body/DocFragment[3]/body/div[1]/p[2]/text()[1].6');
  const point = resolveKOReaderXPath(root, path);
  assert.equal(point.node, word);
  assert.equal(point.offset, offset);
  assert.equal(point.exact, true);
  const after = paragraph.childNodes[2];
  assert.equal(koReaderXPath(root, after, 3, 2), '/body/DocFragment[3]/body/div[1]/p[2]/text()[2].3');
  assert.equal(resolveKOReaderXPath(root, '/body/DocFragment[3]/body/div[1]/p[2]/text()[3].2').node.data, 'fin');
  assert.equal(resolveKOReaderXPath(root, '/body/DocFragment[3]/body/div/p[2]/text().6').offset, offset);
});

test('original element paths survive removal of unsafe elements and their same-tag descendants', () => {
  const root = body('<div><p>Leer</p></div><form><div><p>Quitar</p></div></form><div><p>Guardar</p><p>Final</p></div>');
  annotateSyncPaths(root, 4);
  const text = root.lastChild.lastChild.firstChild;
  const path = koReaderXPath(root, text, 3, 4);
  root.removeChild(root.firstChild);
  root.removeChild(root.firstChild);
  assert.equal(path, '/body/DocFragment[5]/body/div[2]/p[2]/text()[1].3');
  assert.equal(resolveKOReaderXPath(root, path).node, text);
  assert.equal(resolveKOReaderXPath(root, '/body/DocFragment[5]/body/div[1]/p[1]/text()[1].0'), null);
  assert.equal(resolveKOReaderXPath(root, '/body/DocFragment[1]/body/div[2]/p[2]/text()[1].0'), null);
});

test('unsupported/malformed XPaths and out-of-range offsets cannot be reported as exact locations', () => {
  const root = body('<p>Hola</p><p><img src="cover.png"/></p>');
  for (const path of ['//body/DocFragment[1]/body/p[1]', '/body/DocFragment[0]/body',
    '/body/DocFragment[1]junk', '/body/DocFragment[1]/body//p[1]', '/body/DocFragment[1]/body/p[1]/',
    '/body/DocFragment[1]/body/../p[1]', '/body/DocFragment[1]/body/p[1][@id="a"]',
    '/body/DocFragment[1]/body/p[1]/text()[0].1', '/body/DocFragment[1]/body/p[1].12']) assert.equal(parseKOReaderXPath(path), null, path);
  assert.equal(resolveKOReaderXPath(root, '/body/DocFragment[1]/body/p[1]/text()[1].5'), null);
  assert.equal(resolveKOReaderXPath(root, '/body/DocFragment[1]/body/p[3]'), null);
  assert.equal(resolveKOReaderXPath(root, '/body/DocFragment[1]/body/p[2]/img.0').node.nodeName, 'img');
  assert.equal(resolveKOReaderXPath(root, '/body/DocFragment[1]/body').node, root);
});

test('fractions include text and element Range boundaries, exclude invisible code, and fall back inside visible text', () => {
  const root = body('<p>uno🙂</p><script>not visible</script><div><img/><p>dos</p></div>');
  const second = root.lastChild.lastChild.firstChild;
  assert.equal(positionFraction(root, second, 0), 4 / 7);
  assert.equal(positionFraction(root, root, 2), 4 / 7);
  assert.equal(positionFraction(root, root.lastChild, 1), 4 / 7);
  assert.equal(positionFraction(root, root.firstChild.firstChild, 5), 4 / 7);
  assert.equal(positionFraction(root, root, 3), 1);
  const point = pointAtFraction(root, .8);
  assert.equal(point.node, second);
  assert.equal(point.offset, 1);
  assert.equal(point.exact, false);
  assert.equal(pointAtFraction(root, 1).offset, 3);
  const empty = body('<img/>');
  assert.equal(positionFraction(empty, empty, 0), 0);
  assert.equal(pointAtFraction(empty, .7).node, empty);
});

test('percentage fallback uses source section sizes, rather than equally weighted device pages', () => {
  const sizes = [100, 300, 600];
  assert.equal(weightedPercentage(sizes, 1, .5), .25);
  assert.deepEqual(percentagePosition(sizes, .25), { spine: 1, fraction: .5 });
  assert.deepEqual(percentagePosition(sizes, 1), { spine: 2, fraction: 1 });
  assert.deepEqual(percentagePosition(sizes, -1), { spine: 0, fraction: 0 });
});
