let serial = 0;

export function meaningChoices(values, { label = 'meaning', state = { index: 0, expanded: false }, activate = () => {}, changed = () => {}, render } = {}) {
  const choices = values.length ? values : ['Meaning unavailable.'];
  state.index = Math.max(0, Math.min(choices.length - 1, state.index || 0));
  const root = document.createElement('div'); root.className = 'meaning-choices';
  const selected = document.createElement('div'); selected.className = 'meaning-selected'; selected.setAttribute('aria-live', 'polite');
  root.append(selected);
  const toggle = document.createElement('button'), list = document.createElement('div');
  toggle.type = 'button'; toggle.className = 'meaning-toggle'; toggle.setAttribute('aria-label', `Choose another ${label}`);
  list.className = 'meaning-options'; list.id = `meaning-options-${++serial}`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', `${label} variations`);
  toggle.setAttribute('aria-controls', list.id);
  const options = choices.map((choice, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = choice; button.setAttribute('role', 'option');
    button.addEventListener('click', () => { state.index = index; state.expanded = false; update(); toggle.focus({ preventScroll: true }); activate(); });
    return button;
  });
  list.append(...options);
  function update() {
    selected.replaceChildren(render ? render(state.index) : document.createTextNode(choices[state.index]));
    toggle.textContent = `▾ ${state.index + 1}/${choices.length}`; toggle.setAttribute('aria-expanded', String(state.expanded)); list.hidden = !state.expanded;
    for (const [index, option] of options.entries()) option.setAttribute('aria-selected', String(index === state.index));
    if (state.expanded) options[state.index]?.scrollIntoView?.({ block: 'nearest' });
    changed();
  }
  function cycle(step) { activate(); state.index = (state.index + step + choices.length) % choices.length; update(); }
  toggle.addEventListener('click', () => { activate(); state.expanded = !state.expanded; update(); });
  root.addEventListener('pointerenter', activate); root.addEventListener('focusin', activate);
  root.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (choices.length > 1 && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); cycle(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Escape' && state.expanded) { event.preventDefault(); event.stopPropagation(); state.expanded = false; update(); toggle.focus({ preventScroll: true }); }
  });
  if (choices.length > 1) root.append(toggle, list);
  update();
  return { root, cycle, count: choices.length };
}
