import { writeFile } from 'node:fs/promises';

const names = [
  'arrow-left', 'arrow-right', 'banknote', 'bell', 'bell-off', 'calendar-days',
  'camera', 'car-front', 'chart-no-axes-column', 'chart-no-axes-combined',
  'chart-pie', 'check', 'chevron-down', 'chevron-left', 'chevron-right', 'circle-alert', 'circle-check',
  'clock-3', 'copy', 'download', 'eye-off', 'flame', 'hourglass', 'lightbulb',
  'message-circle', 'moon', 'ellipsis-vertical', 'pencil', 'play', 'plus', 'printer',
  'qr-code', 'scan-line', 'search', 'shield-check', 'smartphone', 'sparkles',
  'spray-can', 'sun', 'target', 'timer', 'trash', 'trending-up', 'undo-2',
  'users-round', 'wrench', 'x', 'zap',
];

const symbols = await Promise.all(names.map(async name => {
  const url = `https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/${name}.svg`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const source = await response.text();
  const body = source.replace(/^.*?<svg[^>]*>/s, '').replace(/<\/svg>\s*$/s, '').trim();
  if (!body || body.includes('<svg')) throw new Error(`${name}: SVG inesperado`);
  return `  <symbol id="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`;
}));

// Adapted from the motorcycle pictogram already used in public/styles.css.
const motorcycle = '  <symbol id="motorcycle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="16" r="3"/><circle cx="19" cy="16" r="3"/><path d="M12 17h4l3-6H9l-2 3"/><path d="m8 10 3-4h3"/><path d="M9 6h4"/></symbol>';
await writeFile('public/icons.svg', `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join('\n')}\n${motorcycle}\n</svg>\n`);
console.log(`Generados ${symbols.length + 1} iconos`);
