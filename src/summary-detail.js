import { element } from './ui.js';

export function renderSummaryDetail(target, state, answer) {
  target.dataset.state = state;
  if (state === 'complete' && Array.isArray(answer?.sections) && answer.sections.length) {
    target.replaceChildren(...answer.sections.map(({ heading, text }) => {
      const section = element('section', 'summary-explanation-section');
      section.append(element('h4', '', heading), element('p', '', text));
      return section;
    }));
  } else target.textContent = typeof answer === 'string' ? answer : answer?.text || '';
}
