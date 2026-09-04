import { getIconUrlForFilePath } from 'vscode-material-icons';

/** Where vite-plugin-static-copy serves the icon SVGs from — see vite.config.ts. */
const ICONS_BASE = '/material-icons';

/**
 * File-type icon for a path (VS Code Material Icons: official theme matching —
 * extension, special filenames like Dockerfile, compound suffixes like .d.ts).
 * Always resolves: unknown types fall back to the theme's generic file icon.
 */
export function FileTypeIcon({ path, size = 14 }: { path: string; size?: number }) {
  return (
    <img
      src={getIconUrlForFilePath(path, ICONS_BASE)}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className="tool-file-icon"
    />
  );
}

/**
 * Splits a path into basename + parent directory (with trailing slash, '' at
 * repo root) for the ZCode-style file row: `icon session.ts src/auth/ ±1 −2`.
 */
export function splitFilePath(path: string): { base: string; dir: string } {
  const i = path.lastIndexOf('/');
  if (i === -1) return { base: path, dir: '' };
  return { base: path.slice(i + 1), dir: path.slice(0, i + 1) };
}
