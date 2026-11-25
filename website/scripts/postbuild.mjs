// GitHub Pages has no SPA fallback: serving index.html as 404.html lets
// deep links like /no-mouse/hardware load the app and route client-side.
import { copyFile, writeFile } from 'node:fs/promises'

await copyFile('dist/index.html', 'dist/404.html')
await writeFile('dist/.nojekyll', '')
console.log('postbuild: wrote dist/404.html and dist/.nojekyll')
