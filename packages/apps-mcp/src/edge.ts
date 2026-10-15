/**
 * App hosting E1: the edge bundle's marker file (spec §7). A folder or file map with
 * `create-edge.json` at its root is a PRE-BUILT edge frontend — a Worker module and/or static files —
 * and deploys to the edge tier instead of being built as a container. The format itself is parsed and
 * validated by the API (`apps/api/src/apps-hosting/edge/bundle.ts`); clients only detect it.
 */
export const EDGE_MANIFEST_FILE = 'create-edge.json';

export function isEdgeBundle(paths: Iterable<string>): boolean {
  for (const p of paths) if (p === EDGE_MANIFEST_FILE || p === `./${EDGE_MANIFEST_FILE}`) return true;
  return false;
}
