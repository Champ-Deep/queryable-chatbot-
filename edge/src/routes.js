// Which agent serves a path (same table as the container Worker in /worker/routes.js).
const CHAMPIONS_PATHS = ["/lab", "/.well-known", "/a2a", "/mcp", "/oauth", "/api/v1", "/audit", "/health"];

export function isChampionsPath(pathname) {
  return CHAMPIONS_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
