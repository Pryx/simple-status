/** Whether a request is to `wrangler dev` on this machine (not a deployed Worker). */
export function isLocalhost(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1";
}
