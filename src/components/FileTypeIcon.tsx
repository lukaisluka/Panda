import { getIconUrlForFilePath } from 'vscode-material-icons';

/** Icon SVGs live in public/material-icons (postinstall syncs them), served
 * beside index.html at whatever path the app is deployed under. Resolved
 * from the document rather than `import.meta.env.BASE`: vite 8's rolldown
 * build leaves that uninjected — it compiled to `undefined` in the bundle,
 * which broke every file icon under the /Panda/ Pages subpath. Called at
 * render time, not module load, so importing this module stays DOM-free. */
export function iconsBase(baseUri: string = document.baseURI): string {
  return new URL('material-icons', baseUri).pathname;
}

/**
 * File-type icon for a path (VS Code Material Icons: official theme matching —
 * extension, special filenames like Dockerfile, compound suffixes like .d.ts).
 * Always resolves: unknown types fall back to the theme's generic file icon.
 *
 * 16px box: the theme's artwork only fills ~80% of its viewBox, so the
 * painted glyph lands just above cap height (ZCode reference — the icon
 * should read slightly taller than uppercase letters at 14px text).
 */
export function FileTypeIcon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <img
      src={getIconUrlForFilePath(path, iconsBase())}
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
