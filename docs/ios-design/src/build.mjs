// Builds self-contained prototypes: docs/ios-design/screens/*.html
// Usage: node docs/ios-design/src/build.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screens');
const css = readFileSync(join(here, 'shared.css'), 'utf8');
const js = readFileSync(join(here, 'shared.js'), 'utf8');

// One source can emit several files: [output name, html attributes]
const variants = {
  hem: [
    ['hem', 'data-theme="dark" data-variant="kvall"'],
    ['hem-ljus', 'data-theme="light" data-variant="dag"'],
    ['offline', 'data-theme="dark" data-variant="offline"'],
  ],
};

const part = (src, name) => {
  const m = src.match(
    new RegExp(`<!--${name}-->([\\s\\S]*?)(?=<!--[A-Z]+-->|$)`),
  );
  return m ? m[1].trim() : '';
};

for (const file of readdirSync(join(here, 'screens')).filter((f) =>
  f.endsWith('.html'),
)) {
  const name = file.replace('.html', '');
  const src = readFileSync(join(here, 'screens', file), 'utf8');
  const title = part(src, 'TITLE') || name;
  for (const [outName, attrs] of variants[name] || [
    [name, 'data-theme="dark"'],
  ]) {
    const html = `<!doctype html>
<html lang="sv" ${attrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=402, initial-scale=1, viewport-fit=cover">
<title>Lugn iOS · ${title}</title>
<!-- Inter stands in for SF Pro off Apple hardware. Newsreader loads from web/fonts in this repo. -->
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=block" rel="stylesheet">
<style>
${css}
${part(src, 'STYLE')}
</style>
</head>
<body>
<div class="stage">
<main class="device">
${part(src, 'SCREEN')}
</main>
<aside class="notes">
${part(src, 'NOTES')}
<p><kbd>s</kbd> säkra ytor och tumzon, <kbd>t</kbd> ljust/mörkt, <kbd>g</kbd> glas av (Minska genomskinlighet).</p>
<div class="haptic-log"><b>Haptik (logg)</b></div>
</aside>
</div>
<script>
${js}
</script>
<script>
${part(src, 'SCRIPT')}
</script>
</body>
</html>
`;
    writeFileSync(join(out, `${outName}.html`), html);
    console.log('built', `${outName}.html`);
  }
}
