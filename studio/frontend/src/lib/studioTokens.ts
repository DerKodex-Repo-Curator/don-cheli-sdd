// Design tokens for the B-Studio light theme (Santiago redesign).
// Source: studio/redesign/.../components/b-chrome.jsx

export const studioTokens = {
  bg: '#fafaf7',
  bgAlt: '#f4f4f0',
  panel: '#ffffff',
  border: '#eeeee8',
  borderSoft: '#f4f4ee',
  text: '#0f1114',
  textDim: '#65666b',
  textFaint: '#9a9a9e',
  ink: '#0f1114',
  success: 'oklch(58% 0.14 155)',
  successBg: 'oklch(96% 0.05 155)',
  warn: 'oklch(55% 0.15 75)',
  warnBg: 'oklch(96% 0.06 75)',
  shadow: '0 1px 2px rgba(17,18,22,0.04), 0 6px 20px -12px rgba(17,18,22,0.10)',
  shadowLg: '0 10px 30px -10px rgba(17,18,22,0.30)',
  fontMono: '"Geist Mono", ui-monospace, SFMono-Regular, monospace',
  fontSans: '"Inter", system-ui, -apple-system, sans-serif',
} as const;

export type StudioTokens = typeof studioTokens;
