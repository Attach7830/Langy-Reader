const undoLimit = 50;
const typingInterval = 900;
const typingActions = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward']);
const nativeHistory = (type) => type === 'historyUndo' ? 'undo' : type === 'historyRedo' ? 'redo' : undefined;

export function pdfTextHistory(text, changed) {
  // Keep one stack per page so changing pages preserves both text and history.
  const pages = new Map();
  let page, before, group, composing = false;

  const snapshot = () => ({ value: text.value, start: text.selectionStart, end: text.selectionEnd, direction: text.selectionDirection });
  function apply({ value, start, end, direction }) {
    if (text.value !== value) text.value = value;
    text.setSelectionRange(start, end, direction);
  }
  function record(previous, inputType = '', time = 0) {
    const current = page.current = snapshot();
    if (current.value === previous.value) return;
    const join = group && (composing ? group.composing : typingActions.has(inputType) && group.inputType === inputType
      && time - group.time <= typingInterval && previous.start === previous.end && group.end === previous.start);
    if (!join) {
      page.undo.push(previous);
      if (page.undo.length > undoLimit) page.undo.shift();
    }
    page.redo.length = 0;
    group = { inputType, time, end: current.end, composing };
    changed(current.value);
  }
  function move(direction, previous = snapshot()) {
    if (!page || text.disabled || composing) return;
    before = group = undefined;
    const target = page[direction].pop();
    if (!target) { apply(previous); return; }
    page[direction === 'undo' ? 'redo' : 'undo'].push(previous);
    apply(target);
    page.current = target;
    changed(target.value);
  }

  text.addEventListener('beforeinput', (event) => {
    if (!page) return;
    const direction = nativeHistory(event.inputType);
    if (direction && event.cancelable) {
      event.preventDefault();
      move(direction);
    } else before = snapshot();
  });
  text.addEventListener('input', (event) => {
    if (!page) return;
    const previous = before ?? page.current;
    before = undefined;
    const direction = nativeHistory(event.inputType);
    if (direction) move(direction, previous); // Some native undo events cannot be cancelled in beforeinput.
    else record(previous, event.inputType, event.timeStamp);
  });
  text.addEventListener('compositionstart', () => { composing = true; group = undefined; });
  text.addEventListener('compositionend', () => { composing = false; before = group = undefined; });
  text.addEventListener('blur', () => { group = undefined; });

  return {
    open(number, value) {
      if (page) page.current = snapshot();
      page = pages.get(number);
      if (!page) {
        page = { undo: [], redo: [], current: { value, start: 0, end: 0, direction: 'none' } };
        pages.set(number, page);
      }
      before = group = undefined; composing = false;
      apply(page.current);
      page.current = snapshot();
    },
    replace(value, { start = 0, end = start, direction = 'none' } = {}) {
      if (!page || value === text.value) return;
      const previous = snapshot();
      before = group = undefined;
      apply({ value, start, end, direction });
      record(previous);
    },
    move,
    get canUndo() { return Boolean(page?.undo.length); },
    get canRedo() { return Boolean(page?.redo.length); },
    get composing() { return composing; },
    reset() {
      pages.clear(); page = before = group = undefined; composing = false;
    },
  };
}
