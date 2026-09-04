// Syncs the material file-icon SVGs into public/ so both `vite dev` and
// `vite build` serve them at /material-icons/ natively (FileTypeIcon).
// Runs on postinstall; the output is build input, not source — gitignored.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// The package exports map doesn't expose package.json, so walk up from the
// entry point (dist/index.js → package root).
const pkgDir = join(dirname(require.resolve('vscode-material-icons')), '..');
const dest = fileURLToPath(new URL('../public/material-icons', import.meta.url));

rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(join(pkgDir, 'generated/icons'), dest, { recursive: true });
console.log(`synced material icons -> ${dest}`);
