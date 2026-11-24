export function locationHistory({ location, go, changed = () => {} }) {
  let entries = [], busy = false, version = 0;
  const report = () => changed({ previous: entries.at(-1) || null, busy, count: entries.length });
  async function navigate(target, back) {
    if (busy) return false;
    const from = location(), epoch = version, previous = back ? entries.at(-1) : null;
    if (back && !previous) return false;
    busy = true; report();
    try {
      const moved = await go(back ? previous.target : target, back ? previous : null);
      if (epoch !== version || moved !== true) return false;
      if (back) entries.pop();
      else if (from && from.target !== location()?.target) {
        entries.push(from); if (entries.length > 50) entries.shift();
      }
      return true;
    } finally { if (epoch === version) { busy = false; report(); } }
  }
  return { follow: (target) => navigate(target, false), back: () => navigate(null, true), refresh: report,
    reset() { version++; entries = []; busy = false; report(); },
  };
}
