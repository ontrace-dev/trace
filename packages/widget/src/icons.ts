const svg = (paths: string, size = 22) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  chat: (s?: number) => svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>', s),
  help: (s?: number) =>
    svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>', s),
  sparkle: (s?: number) =>
    svg(
      '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
      s,
    ),
  wave: (s?: number) =>
    svg(
      '<path d="M18 11V6a2 2 0 0 0-4 0v1"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
      s,
    ),
  close: (s = 18) => svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', s),
  chevronDown: (s = 22) => svg('<path d="m6 9 6 6 6-6"/>', s),
  back: (s = 18) => svg('<path d="m15 18-6-6 6-6"/>', s),
  send: (s = 16) => svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>', s),
  plus: (s = 16) => svg('<path d="M5 12h14"/><path d="M12 5v14"/>', s),
  arrowRight: (s = 14) => svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>', s),
  check: (s = 12) => svg('<path d="M20 6 9 17l-5-5"/>', s),
};

export type LauncherIcon = "chat" | "help" | "sparkle" | "wave";
