import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` emits ONE self-contained dist/index.html (JS + CSS inlined)
// that opens straight from the file system — handy for a class presentation.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { target: 'es2022' },
});
