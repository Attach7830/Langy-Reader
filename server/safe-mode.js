// Restricted readers can use saved media and maintain their own reading data.
// New routes require an explicit decision before they are available in Safe mode.
const allowed = {
  GET: [
    /^\/api\/(?:library|categories|reading-time|proficiency|settings\/reader|vocabulary(?:\/settings)?|fonts)$/u,
    /^\/api\/fonts\/[^/]+\/file$/u,
    /^\/api\/books\/[^/]+\/(?:file|cover|progress|bookmarks|learning|search|narration|epub-text|chapters\/[^/]+|audio\/[^/]+)$/u,
    /^\/api\/books\/[^/]+\/vocabulary\/(?:below-threshold|sections\/[^/]+)$/u,
  ],
  POST: [
    /^\/api\/account\/password$/u,
    /^\/api\/books\/[^/]+\/(?:bookmarks(?:\/remove)?|reading-time|vocabulary\/seen)$/u,
  ],
  PATCH: [
    /^\/api\/settings\/reader$/u,
    /^\/api\/books\/[^/]+\/(?:read-status|currently-reading|set-aside)$/u,
  ],
  PUT: [
    /^\/api\/(?:proficiency|vocabulary\/settings|books\/[^/]+\/progress)$/u,
  ],
  DELETE: [
    /^\/api\/books\/[^/]+\/bookmarks\/[^/]+$/u,
  ],
};

export function safeModeAllows(method, path) {
  const verb = method === 'HEAD' ? 'GET' : method;
  const route = path.replace(/\/$/u, '');
  return Object.hasOwn(allowed, verb) && allowed[verb].some((pattern) => pattern.test(route));
}
