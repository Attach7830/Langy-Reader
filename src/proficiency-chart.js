const NS = 'http://www.w3.org/2000/svg';
const node = (name, attrs = {}, text) => { const value = document.createElementNS(NS, name); for (const [key, item] of Object.entries(attrs)) value.setAttribute(key, String(item)); if (text !== undefined) value.textContent = text; return value; };
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const dateLabel = (date) => new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone:'UTC' });

export function proficiencyChart(host, points, { label, hours = false } = {}) {
  host.replaceChildren();
  const svg = node('svg', { viewBox: '0 0 960 310', role: 'img', 'aria-label': label + ' over time', class: 'proficiency-svg' });
  svg.append(node('title', {}, label + ' over time'), node('desc', {}, 'Recorded observations only. Focus a point or move over the chart to read its value.'));
  const defs = node('defs'), gradient = node('linearGradient', { id: 'proficiency-fill', x1: 0, x2: 0, y1: 0, y2: 1 });
  gradient.append(node('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': .23 }), node('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': .01 })); defs.append(gradient); svg.append(defs);
  const left = 68, right = 930, top = 24, bottom = 260, values = points.map((point) => point.value), max = Math.max(1, ...values) * 1.12;
  const times = points.map((point) => Date.parse(point.date)), start = times[0] || Date.now(), end = times.at(-1) || start;
  const x = (time) => start === end ? (left + right) / 2 : left + (time - start) / (end - start) * (right - left), y = (value) => bottom - value / max * (bottom - top);
  for (let index = 0; index <= 4; index++) {
    const value = max * index / 4, cy = y(value);
    svg.append(node('line', { x1: left, x2: right, y1: cy, y2: cy, class: 'proficiency-grid' }), node('text', { x: left - 14, y: cy + 5, 'text-anchor': 'end', class: 'proficiency-axis' }, number.format(value)));
  }
  const coordinates = points.map((point, index) => [x(times[index]), y(point.value)]);
  if (points.length > 1) {
    const path = coordinates.map(([cx, cy], index) => index ? hours ? `L${cx},${cy}` : `H${cx}V${cy}` : `M${cx},${cy}`).join(' ');
    svg.append(node('path', { d: path + ` L${coordinates.at(-1)[0]},${bottom} L${coordinates[0][0]},${bottom} Z`, fill: 'url(#proficiency-fill)' }), node('path', { d: path, fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
  }
  const tooltip = document.createElement('p'); tooltip.className = 'proficiency-chart-caption'; tooltip.setAttribute('role', 'status');
  const show = (index) => { const point = points[index]; tooltip.textContent = point ? `${dateLabel(point.date)} · ${number.format(point.value)} ${label.toLowerCase()}` : 'Your first observation appears here as you read.'; };
  coordinates.forEach(([cx, cy], index) => {
    const point = node('circle', { cx, cy, r: points.length === 1 ? 6 : 4, tabindex: 0, class: 'proficiency-point', 'aria-label': `${dateLabel(points[index].date)}: ${number.format(points[index].value)} ${label}` });
    point.addEventListener('focus', () => show(index)); point.addEventListener('pointerenter', () => show(index));
    point.addEventListener('keydown', (event) => { if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const next = Math.max(0, Math.min(points.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))); svg.querySelectorAll('.proficiency-point')[next].focus(); } }); svg.append(point);
  });
  const labels = [...new Set([0, points.length - 1])].filter((index) => index >= 0 && points[index]);
  for (const index of labels) svg.append(node('text', { x: x(times[index]), y: 295, 'text-anchor': points.length === 1 ? 'middle' : index ? 'end' : 'start', class: 'proficiency-axis' }, dateLabel(points[index].date)));
  svg.addEventListener('pointermove', (event) => {
    const bounds = svg.getBoundingClientRect(), cx = (event.clientX - bounds.left) / bounds.width * 960;
    if (coordinates.length) show(coordinates.reduce((best, point, index) => Math.abs(point[0] - cx) < Math.abs(coordinates[best][0] - cx) ? index : best, 0));
  });
  show(points.length - 1); host.append(svg, tooltip);
}
