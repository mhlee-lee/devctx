import { codeDbPath } from './files.ts';
import { Graph, type GraphSnapshot } from './graph.ts';
import { CodeStore } from './store.ts';

/**
 * Graph access for short-lived query processes (`devctx code <tool>`). Resolution runs once per
 * index generation, in whichever process first needs it; every later query only replays the
 * stored snapshot.
 */

function save(root: string, g: Graph): boolean {
  try {
    const store = CodeStore.open(codeDbPath(root));
    try {
      // A sync that landed meanwhile owns the newer generation; never overwrite it with this one.
      if ((store.meta('generation') ?? '0') !== g.generation) return false;
      store.saveSnapshot(g.generation, JSON.stringify(g.snapshot()));
      return true;
    } finally {
      store.close();
    }
  } catch {
    return false; // read-only checkout or sandbox: the next writable process saves it
  }
}

/** Builds the graph from the stored facts and caches its snapshot (after an index run). */
export function buildSnapshot(root: string): Graph | null {
  const store = CodeStore.openExisting(codeDbPath(root));
  if (!store) return null;
  let g: Graph;
  try {
    g = Graph.load(store);
  } finally {
    store.close();
  }
  save(root, g);
  return g;
}

/** Whether the cached snapshot matches the index (so a query needs no resolution). */
export function snapshotFresh(root: string): boolean {
  const store = CodeStore.openExisting(codeDbPath(root));
  if (!store) return false;
  try {
    return store.snapshot()?.generation === (store.meta('generation') ?? '0');
  } finally {
    store.close();
  }
}

/** The graph for a query: the snapshot when it matches the index generation, else a fresh build. */
export function loadGraph(root: string): Graph | null {
  const store = CodeStore.openExisting(codeDbPath(root));
  if (!store) return null;
  let g: Graph | null = null;
  try {
    const gen = store.meta('generation') ?? '0';
    const snap = store.snapshot();
    if (snap && snap.generation === gen) {
      try {
        g = Graph.fromSnapshot(JSON.parse(snap.data) as GraphSnapshot);
      } catch {
        g = null;
      }
      if (g) return g;
    }
    g = Graph.load(store);
  } finally {
    store.close();
  }
  save(root, g);
  return g;
}
