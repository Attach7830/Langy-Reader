import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const pending = new Set(['queued', 'running', 'generating', 'aligning', 'assembling', 'syncing', 'linking', 'awaiting_confirmation', 'downloading', 'importing', 'scanning', 'searching', 'ranking', 'retry_wait', 'needs_action', 'waiting']);
const state = (value) => ['error', 'failed', 'needs_review'].includes(value) ? 'failed' : ['retry_wait', 'needs_action', 'waiting', 'awaiting_confirmation'].includes(value) ? 'waiting'
  : value === 'queued' ? 'queued' : pending.has(value) ? 'running' : value === 'cancelled' ? 'cancelled' : 'completed';

// A small read-only projection: no NLP, filesystem scans, remote connections or
// provider calls belong on this polling endpoint.
export function openProcesses(dir, { library, archive, webImports, discovery, learning, demo = false, account }) {
  const databases = new Map();
  function rows(file, sql) {
    let db = databases.get(file);
    if (!db) { db = new DatabaseSync(join(dir, file), { readOnly: true }); db.exec('PRAGMA busy_timeout=500'); databases.set(file, db); }
    return db.prepare(sql).all();
  }
  function list(visitor) {
    const books = new Map(library.snapshot(visitor).books.map((book) => [book.id, book])), jobs = [], latest = new Map(), groups = new Map(); let unavailable = false;
    function add(kind, row, label, { book = row.book, created = row.created || row.queuedAt || 0, progress = null, detail = '' } = {}) {
      const owned = book && books.get(book); if (book && !owned) return;
      const status = state(row.state);
      const group = `${kind}:${book || row.id}:${label}`, id = `${kind}:${row.id || book}`;
      if (!latest.has(group) || created > latest.get(group).created) latest.set(group, { id, created });
      groups.set(id, group);
      // History stays with the relevant book/import; the queue only shows work
      // still in progress or errors that the reader can act on.
      if (!pending.has(row.state) && status !== 'failed') return;
      jobs.push({ id: `${kind}:${row.id || book}`, kind, label, state: status, phase: row.state, bookId: owned?.id,
        title: owned?.title || row.details?.title || row.title || '', created, progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null,
        detail: row.error || detail, nextAttempt: row.nextAttempt || row.retryAt || null,
        cancellable: pending.has(row.state) && owned?.canEdit !== false && !(['ocr','web-import'].includes(kind) && row.state === 'importing'),
        ...(kind === 'web-import' && row.state === 'error' ? {retry:row.id} : {}),
        ...(kind === 'ocr' && row.state === 'error' && owned?.canEdit !== false ? { retryOcr: row.id } : {}),
        ...(kind === 'audiobookshelf' && row.kind === 'export' && row.state === 'needs_review' && row.uploadFilename ? { checkUpload: row.id } : {}),
        ...(kind === 'audiobookshelf' && row.state === 'awaiting_confirmation' ? { decision: row.id } : {}) });
    }
    function read(file, sql, visit) { try { for (const row of rows(file, sql)) visit(row); } catch { unavailable = true; } }
    read('learning.sqlite', "SELECT book,state,error FROM analyses WHERE state!='ready'", (row) => add('analysis', row, 'Vocabulary analysis'));
    read('learning.sqlite', "SELECT book,state,error,queuedAt FROM estimates WHERE state!='ready'", (row) => add('estimate', row, 'Reading demand estimate'));
    const parentAudio = new Set();
    read('learning.sqlite', "SELECT id,book,state,error,created FROM book_audio ORDER BY created DESC LIMIT 200", (row) => {
      if (pending.has(row.state) || row.state === 'error') parentAudio.add(row.book); add('narration', row, 'Generate audiobook');
    });
    read('learning.sqlite', "SELECT id,book,state,error,created FROM audio WHERE state IN ('queued','generating','aligning','error') ORDER BY created DESC LIMIT 300", (row) => {
      if (!parentAudio.has(row.book)) add('audio-section', row, row.state === 'aligning' ? 'Align spoken words' : 'Narrate book section');
    });
    read('learning.sqlite', "SELECT id,book,name,state,error,created,progress FROM recordings WHERE state NOT IN ('ready','uploaded') ORDER BY created DESC LIMIT 100", (row) => add('recording', row, 'Sync audiobook with text', { progress: row.progress * 100, detail: row.name }));
    read('learning.sqlite', "SELECT id,book,state,error,created,cursor,windows FROM audio_rescans WHERE state!='ready' ORDER BY created DESC LIMIT 100", (row) => {
      const total = JSON.parse(row.windows).length; add('repair', row, 'Repair audio alignment', { progress: total ? row.cursor / total * 100 : null });
    });
    read('learning.sqlite', "SELECT id,book,state,error,created,bytes FROM ivoox_imports ORDER BY created DESC LIMIT 100", (row) => add('ivoox', row, 'Download iVoox audio', { detail: row.bytes ? `${(row.bytes / 1024 ** 2).toFixed(1)} MiB downloaded` : '' }));
    for (const row of learning.textProcesses()) add('indexing', row, 'Index book text and count words');
    if (!demo) {
      read('learning.sqlite', "SELECT book,due,minutes,state,error FROM import_narration WHERE state IN ('waiting','error')", (row) => add('scheduled-narration', row, 'Scheduled audiobook', {
        created: row.due - row.minutes * 60000, detail: row.due > Date.now() ? `Starts after ${new Date(row.due).toLocaleString()}` : 'Waiting for Kokoro, analysis and a generation slot',
      }));
      for (const row of archive.list(visitor)) add('archive', row, 'Download book', { book: row.book?.id, progress: row.total ? row.bytes / row.total * 100 : null, detail: row.notice || '' });
      read('pdf-ocr.sqlite', 'SELECT json FROM jobs ORDER BY rowid DESC LIMIT 100', (value) => { const row = JSON.parse(value.json); add('ocr', row, 'Scan PDF with OCR', { book: row.source, detail: row.notice || '' }); });
      if (!visitor?.authenticated || visitor.id === '') read('audiobookshelf.sqlite', 'SELECT json FROM jobs ORDER BY rowid DESC LIMIT 100', (value) => { const row = JSON.parse(value.json); add('audiobookshelf', row, row.kind === 'export' ? 'Export to Audiobookshelf' : 'Import from Audiobookshelf', { detail: row.notice || '' }); });
    }
    for (const row of webImports?.list(visitor) || []) add('web-import',row,'Download book from web',{book:row.book,progress:row.total ? row.bytes/row.total*100 : null,detail:row.bytes ? `${(row.bytes/1024**2).toFixed(1)} MiB downloaded` : ''});
    const found = discovery.status(visitor);
    if (found.id && (found.busy || found.error)) add('discovery', { id: found.id, state: found.state, error: found.error }, 'Discover similar books');
    jobs.sort((a, b) => Number(['completed', 'cancelled'].includes(a.state)) - Number(['completed', 'cancelled'].includes(b.state)) || b.created - a.created);
    return { accountId: account(visitor).id, jobs: jobs.filter((job) => job.state !== 'failed' || latest.get(groups.get(job.id))?.id === job.id).slice(0, 200), unavailable };
  }
  return { list, close() { for (const db of databases.values()) db.close(); } };
}
