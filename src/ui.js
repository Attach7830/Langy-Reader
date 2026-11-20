import {
  createIcons, ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Coffee, Folder, Info, Languages,
  LibraryBig, List, Maximize, Minus, Pencil, Plus, RotateCcw, Search, Settings2, SkipBack, SkipForward, Sparkles, Upload, X, Headphones,
} from 'lucide';

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
    LibraryBig, List, Maximize, Minus, Pencil, Plus, RotateCcw, Search, Settings2, SkipBack, SkipForward, Sparkles, Upload, X, Headphones } });
}

export async function api(path, { body, method, signal } = {}) {
  const form = body instanceof FormData;
  const response = await fetch(path, {
    method, signal,
    headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? form ? body : JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || 'Langy Reader could not complete the request.');
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
