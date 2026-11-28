import { RequestError } from './books.js';

const maxPoints = 200;
const timed = ({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start;

function correctedTimings(timings, segment, points) {
  if (!points.length) return timings;
  const { start, end, scale } = segment;
  const duration = (end - start) / scale;
  if (!Number.isFinite(duration) || duration <= 0 || scale <= 0) throw new RequestError(422, 'Sync this section with the audiobook first.');
  const words = timings.filter(timed);
  const byOffset = new Map(words.map((word) => [word.from, word]));
  const confirmed = new Set();
  const anchors = [{ original: 0, corrected: 0 }];
  for (const { from, time } of points) {
    const word = byOffset.get(from);
    if (!word) throw new RequestError(422, 'Choose a word with a time in this recording.');
    const original = word.start, corrected = (time - start) / scale;
    if (time < start || time >= end || original < 0 || original >= duration) {
      throw new RequestError(422, 'Choose a time within this section’s audio.');
    }
    const previous = anchors.at(-1);
    if (word === words[0] && !confirmed.size && (original === 0 || corrected === 0)) {
      // A first-word correction can add or remove leading silence.
      anchors[0] = { original, corrected };
    } else {
      if (original <= previous.original || corrected <= previous.corrected) {
        throw new RequestError(422, 'Sync points must follow the order of the words and have different times.');
      }
      anchors.push({ original, corrected });
    }
    confirmed.add(from);
  }
  anchors.push({ original: duration, corrected: duration });

  function mapTime(time) {
    if (time <= anchors[0].original) return anchors[0].corrected;
    if (time >= duration) return duration;
    let low = 0, high = anchors.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (anchors[middle].original <= time) low = middle; else high = middle;
    }
    const left = anchors[low], right = anchors[high];
    const fraction = (time - left.original) / (right.original - left.original);
    return left.corrected + fraction * (right.corrected - left.corrected);
  }
  return timings.map((word) => timed(word) ? {
    ...word, start: mapTime(word.start), end: mapTime(word.end),
    ...(confirmed.has(word.from) ? { estimated: false, review: false } : {}),
  } : word);
}

function normalizePoints(value) {
  if (!Array.isArray(value) || value.length > maxPoints) throw new RequestError(422, `Use up to ${maxPoints} sync points per section.`);
  const points = value.map((point) => {
    if (!Number.isSafeInteger(point?.from) || point.from < 0 || !Number.isFinite(point.time)) {
      throw new RequestError(422, 'Choose a word and a valid time for each sync point.');
    }
    return { from: point.from, time: point.time };
  });
  return points.sort((a, b) => a.from - b.from);
}

export function epubAudioTiming(db, currentRecording) {
  db.exec(`CREATE TABLE IF NOT EXISTS epub_audio_timing (
    recording TEXT NOT NULL REFERENCES book_audio(id) ON DELETE CASCADE,
    key TEXT NOT NULL, textHash TEXT NOT NULL, points TEXT NOT NULL,
    PRIMARY KEY(recording,key)
  ) STRICT, WITHOUT ROWID;`);
  const stored = db.prepare('SELECT points FROM epub_audio_timing WHERE recording=? AND key=? AND textHash=?');
  const wordData = db.prepare(`SELECT chapters.text,audio.timings FROM chapters
    JOIN audio ON audio.book=chapters.book AND audio.chapter=chapters.key AND audio.digest=chapters.digest
    WHERE chapters.book=? AND chapters.key=? AND chapters.digest=? AND audio.id=? AND audio.state='ready'`);
  const pointsFor = (recording, segment) => JSON.parse(stored.get(recording, segment.key, segment.textHash)?.points || '[]');

  function sectionFor(book, id, key) {
    const recording = currentRecording(book, id);
    const sections = JSON.parse(recording.segments).filter(({ key, start, end, scale }) =>
      /^epub:\d+$/u.test(key) && Number.isFinite(start) && Number.isFinite(end) && end > start && Number.isFinite(scale) && scale > 0);
    const segment = key === undefined ? sections[0] : sections.find((part) => part.key === key);
    if (!segment) throw new RequestError(422, 'Choose a section included in this recording.');
    const source = wordData.get(book.id, segment.key, segment.textHash, segment.audioId);
    const timings = JSON.parse(source?.timings || '[]');
    if (!timings.some(timed)) throw new RequestError(409, 'Sync this section with the audiobook first.');
    return { recording, sections, segment, timings, text: source.text };
  }

  function readTimings(segment, timings, points) {
    try { return { timings: correctedTimings(timings, segment, points), needsReview: false }; }
    catch (error) {
      // A new automatic alignment can change the original word order or section bounds.
      if (!(error instanceof RequestError)) throw error;
      return { timings, needsReview: true };
    }
  }

  function get(book, id, key) {
    const { recording, sections, segment, timings, text } = sectionFor(book, id, key);
    const points = pointsFor(id, segment);
    const current = readTimings(segment, timings, points);
    const { start, end, scale } = segment;
    return {
      revision: recording.alignmentRevision, url: `/api/books/${book.id}/audio/${id}`,
      sections: sections.map(({ key, title }) => ({ key, title })),
      section: { key: segment.key, start, end, text, points, needsReview: current.needsReview,
        words: current.timings.filter(timed).map(({ from, to, start: time }) => [from, to, start + time * scale]) },
    };
  }

  return {
    get,
    apply(id, segment, timings) {
      return readTimings(segment, timings, pointsFor(id, segment)).timings;
    },
    save(book, id, body) {
      if (typeof body?.key !== 'string') throw new RequestError(422, 'Choose a section included in this recording.');
      db.exec('BEGIN IMMEDIATE');
      try {
        const { recording, segment, timings } = sectionFor(book, id, body.key);
        if (body.revision !== recording.alignmentRevision) throw new RequestError(409, 'The audio timing changed. Reopen the editor before saving.');
        const points = normalizePoints(body.points);
        correctedTimings(timings, segment, points);
        const value = JSON.stringify(points);
        if (value !== JSON.stringify(pointsFor(id, segment))) {
          if (points.length) db.prepare(`INSERT INTO epub_audio_timing(recording,key,textHash,points) VALUES(?,?,?,?)
            ON CONFLICT(recording,key) DO UPDATE SET textHash=excluded.textHash,points=excluded.points`)
            .run(id, segment.key, segment.textHash, value);
          else db.prepare('DELETE FROM epub_audio_timing WHERE recording=? AND key=?').run(id, segment.key);
          db.prepare('UPDATE book_audio SET alignmentRevision=alignmentRevision+1 WHERE id=?').run(id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return get(book, id, body.key);
    },
  };
}
