export const bookCovers = {
  auto: 'Original / automatic',
  terracotta: 'Terracotta', forest: 'Forest', ocean: 'Ocean', midnight: 'Night sky', parchment: 'Parchment', plum: 'Plum geometry',
};
export function validCoverStyle(value) { return typeof value === 'string' && Object.hasOwn(bookCovers, value); }
