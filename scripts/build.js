import { mkdir, copyFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
for (const file of ['index.html', 'styles.css', 'app.js', 'data.js', 'sync.js', '_headers', '_routes.json']) {
  await copyFile(file, `dist/${file}`);
}
