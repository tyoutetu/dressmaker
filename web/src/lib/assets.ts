/**
 * Assets under web/public must be resolved through Vite's BASE_URL, otherwise
 * a GitHub Pages project site served from /<repo>/ would request them from the
 * domain root and 404.
 */
export function assetUrl(publicPath: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${publicPath.replace(/^\/+/, "")}`;
}
