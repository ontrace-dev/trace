const svg = (paths: string, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  plus: (s?: number) => svg('<path d="M5 12h14"/><path d="M12 5v14"/>', s),
  back: (s = 15) => svg('<path d="m15 18-6-6 6-6"/>', s),
  search: (s = 18) => svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', s),
  check: (s = 16) => svg('<path d="M20 6 9 17l-5-5"/>', s),
  mail: (s = 20) =>
    svg('<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>', s),
  clip: (s = 13) =>
    svg(
      '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
      s,
    ),
  external: (s = 13) =>
    svg(
      '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
      s,
    ),
  sparkle: (s = 14) =>
    svg(
      '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/>',
      s,
    ),
};
