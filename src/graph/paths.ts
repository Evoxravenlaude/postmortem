import type { PathEdge, PathNode, PathView } from "../types.js";

type FNode = { id: number; labels: string[]; properties: Record<string, any> };
type FEdge = { id: number; sourceId: number; destinationId: number; relationshipType: string; properties: Record<string, any> };
type FPath = { nodes: FNode[]; edges: FEdge[] };

const KEEP_EDGE = ["tx", "ts", "symbol", "amount", "method", "unlimited", "kind", "by", "via", "raw", "active"];

export function nodeId(n: FNode): string {
  return String(n.properties.addr ?? n.properties.hash ?? n.properties.id ?? `n${n.id}`);
}

export function toPathNode(n: FNode): PathNode {
  const p = n.properties;
  return {
    id: nodeId(n),
    label: n.labels?.[0] ?? "Node",
    name: p.name ?? p.ens ?? p.symbol ?? undefined,
    props: pick(p, ["isContract", "verified", "tags", "wallet", "symbol", "kind", "status"]),
  };
}

/** Turns a FalkorDB path (or a loose bag of nodes and edges) into something the UI can draw. */
export function pathView(title: string, p: FPath | { nodes: FNode[]; edges: FEdge[] }): PathView {
  const byInternal = new Map<number, string>();
  const nodes: PathNode[] = [];
  for (const n of p.nodes) {
    byInternal.set(n.id, nodeId(n));
    nodes.push(toPathNode(n));
  }
  const edges: PathEdge[] = p.edges
    .filter((e) => byInternal.has(e.sourceId) && byInternal.has(e.destinationId))
    .map((e) => ({ from: byInternal.get(e.sourceId)!, to: byInternal.get(e.destinationId)!, type: e.relationshipType, props: pick(e.properties, KEEP_EDGE) }));
  return { title, nodes: dedupe(nodes), edges };
}

/** Joins several paths into one view, merging shared nodes. */
export function mergeViews(title: string, views: PathView[]): PathView {
  const nodes = dedupe(views.flatMap((v) => v.nodes));
  const seen = new Set<string>();
  const edges = views.flatMap((v) => v.edges).filter((e) => {
    const k = `${e.from}|${e.to}|${e.type}|${e.props?.tx ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { title, nodes, edges };
}

function dedupe(nodes: PathNode[]): PathNode[] {
  const m = new Map<string, PathNode>();
  for (const n of nodes) m.set(n.id, { ...m.get(n.id), ...n });
  return [...m.values()];
}

function pick(o: Record<string, any>, keys: string[]) {
  const out: Record<string, any> = {};
  for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null) out[k] = o[k];
  return out;
}
