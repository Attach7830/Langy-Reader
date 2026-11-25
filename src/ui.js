import {
  createIcons, ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Coffee, Folder, Info, Languages,
  LibraryBig, List, Maximize, Minus, Pencil, Plus, RotateCcw, Search, Settings2, SkipBack, SkipForward, Sparkles, Star, Upload, X, Headphones, Bookmark, Download,
} from 'lucide';
import { offlineRequest } from './offline.js';
import { processTasks, requestProcessLabel } from './process-tasks.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function icon(name) {
  const node = document.createElement('i');
  node.dataset.lucide = name;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function drawIcons() {
  createIcons({ icons: { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Coffee, Folder, Info, Languages,
    LibraryBig, List, Maximize, Minus, Pencil, Plus, RotateCcw, Search, Settings2, SkipBack, SkipForward, Sparkles, Star, Upload, X, Headphones, Bookmark, Download } });
}

export async function api(path, options = {}) {
  const label = requestProcessLabel(path, options.method || 'GET'), finish = label ? processTasks.begin(label) : null;
  try {
    const result = await requestAPI(path, options); finish?.();
    if (options.method && options.method !== 'GET' && /\/(?:learning|narration|reading-estimate|recordings|ivoox|ocr|audiobookshelf|imports|discovery)(?:\/|$)/u.test(path)) {
      if (globalThis.window?.CustomEvent) window.dispatchEvent(new window.CustomEvent('langy-processes-changed'));
    }
    return result;
  } catch (error) { finish?.(error.offline && (!options.method || options.method === 'GET') ? undefined : error); throw error; }
}
async function requestAPI(path, { body, method, signal, keepalive } = {}) {
  const form = body instanceof FormData;
  let response;
  try { response = await fetch(path, {
    method, signal, keepalive,
    headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? form ? body : JSON.stringify(body) : undefined,
  }); if (response.headers.get('X-Langy-Offline') === '1') throw new TypeError('Offline'); }
  catch (error) {
    if (error.name === 'AbortError' || signal?.aborted) throw error;
    try { return await offlineRequest(path, { body, method }); }
    catch (offlineError) { offlineError.offline = true; throw offlineError; }
  }
  if (response.headers.get('X-Langy-Cached') === '1' && (path === '/api/library' || /\/bookmarks$/u.test(path))) return offlineRequest(path, { body, method });
  if (response.status === 204) return;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(result?.error || 'Langy Reader could not complete the request.');
    if (result?.authenticationRequired && globalThis.window?.CustomEvent) window.dispatchEvent(new window.CustomEvent('langy-auth-expired'));
    error.status = response.status;
    error.details = result;
    throw error;
  }
  return result;
}

let toastTimer;
export function toast(text) {
  const target = $('#toast');
  clearTimeout(toastTimer);
  target.textContent = text;
  target.hidden = false;
  toastTimer = setTimeout(() => { target.hidden = true; }, 3300);
}

export function message(selector, text = '') {
  const node = $(selector);
  node.textContent = text;
  node.hidden = !text;
}
