import { FalkorDB } from "falkordb";

type Graph = ReturnType<FalkorDB["selectGraph"]>;

let dbPromise: Promise<FalkorDB> | null = null;
const indexed = new Set<string>();

export function falkorUrl(): string {
  return process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379";
}

export async function db(): Promise<FalkorDB> {
  if (!dbPromise) {
    const u = new URL(falkorUrl());
    dbPromise = FalkorDB.connect({
      socket: { host: u.hostname, port: Number(u.port || 6379), ...(u.protocol === "rediss:" ? { tls: true as const } : {}) },
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

export function graphName(chain: string): string {
  return `${process.env.GRAPH_PREFIX ?? "postmortem"}_${chain}`;
}

/** One graph per chain, so addresses never collide across networks. */
export async function graphFor(chain: string): Promise<Graph> {
  const g = (await db()).selectGraph(graphName(chain));
  if (!indexed.has(chain)) {
    for (const [label, prop] of [["Address", "addr"], ["Token", "addr"], ["Tx", "hash"], ["Action", "id"], ["Report", "id"]] as const) {
      try {
        await g.createNodeRangeIndex(label, prop);
      } catch {
        /* index already exists */
      }
    }
    for (const [rel, prop] of [["SENT", "tx"], ["CALLED", "tx"]] as const) {
      try {
        await g.createEdgeRangeIndex(rel, prop);
      } catch {
        /* index already exists */
      }
    }
    indexed.add(chain);
  }
  return g;
}

/** Runs a query and records its text, so every answer can show the Cypher behind it. */
export class Q {
  readonly log: string[] = [];
  constructor(readonly g: Graph) {}

  async rw<T = Record<string, any>>(cypher: string, params: Record<string, any> = {}): Promise<T[]> {
    this.log.push(clean(cypher));
    const r = await this.g.query<T>(cypher, { params });
    return (r.data ?? []) as T[];
  }

  async ro<T = Record<string, any>>(cypher: string, params: Record<string, any> = {}): Promise<T[]> {
    this.log.push(clean(cypher));
    const r = await this.g.roQuery<T>(cypher, { params });
    return (r.data ?? []) as T[];
  }
}

function clean(c: string): string {
  return c.replace(/\s+/g, " ").trim();
}

export async function closeDb() {
  if (dbPromise) {
    const d = await dbPromise;
    dbPromise = null;
    indexed.clear();
    await d.close();
  }
}
