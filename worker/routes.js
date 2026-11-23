// Which agent in the container serves a path.
export const CHAMPIONS_PORT = 9100;
export const PERSONAL_PORT = 9200;

// Paths served by the Champions Group Agent; everything else is the Personal Agent.
const CHAMPIONS_PATHS = ["/lab", "/.well-known", "/a2a", "/mcp", "/oauth", "/api/v1", "/audit", "/health"];

export function portFor(pathname) {
  const champions = CHAMPIONS_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
  return champions ? CHAMPIONS_PORT : PERSONAL_PORT;
}
