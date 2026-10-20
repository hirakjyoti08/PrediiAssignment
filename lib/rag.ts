import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type Chunk = {
  doc: string; // file name, e.g. "chapter-1.md"
  section: string; // heading trail, e.g. "Methods > Data preparation"
  text: string;
};
export type Index = { docs: string[]; chunks: Chunk[] };
export type Hit = { chunk: Chunk; score: number };

// Must match the model loaded in embed_server.py
const MODEL = "BAAI/bge-base-en-v1.5";
// The Python server embeds the chunks and stores/searches them in SQLite.
const SERVER = process.env.EMBED_SERVER ?? "http://127.0.0.1:8001";
const BATCH = 128; // chunks per request while indexing (keeps each request short)

const DATA_DIR = path.join(process.cwd(), "pdf"); // folder with your .md files

// Kept on globalThis so the index state survives Next.js hot reloads in dev.
const g = globalThis as unknown as { __predii?: { index?: Promise<Index> } };
const state = (g.__predii ??= {});

async function call<T>(route: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(SERVER + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(
      `Could not reach the embedding server at ${SERVER}. Is embed_server.py running? (${(e as Error).message})`,
    );
  }
  if (!res.ok) throw new Error(`Embedding server ${route} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Splits markdown by headings, then packs paragraphs into ~900 character chunks.
 * Every chunk remembers the heading trail it sits under so answers can cite the section.
 */
export function chunkMarkdown(md: string, size = 900, overlap = 150) {
  const out: { section: string; text: string }[] = [];
  const trail: string[] = [];
  let buf: string[] = [];
  let inFence = false;

  const windows = (section: string, text: string) => {
    for (let s = 0; s < text.length; s += size - overlap) {
      out.push({ section, text: text.slice(s, s + size).trim() });
      if (s + size >= text.length) break;
    }
  };

  const flush = () => {
    const body = buf.join("\n").trim();
    buf = [];
    if (!body) return;
    const section = trail.filter(Boolean).join(" > ");
    let cur = "";
    for (const p of body.split(/\n{2,}/)) {
      if (p.length > size) {
        // a huge paragraph or table: cut it into windows
        if (cur.trim()) out.push({ section, text: cur.trim() });
        cur = "";
        windows(section, p);
        continue;
      }
      if (cur && cur.length + p.length + 2 > size) {
        out.push({ section, text: cur.trim() });
        // carry a little of the previous chunk forward, starting at a word boundary
        const tail = cur.slice(-overlap).replace(/^\S*\s/, "");
        cur = tail ? `${tail}\n\n${p}` : p;
      } else {
        cur = cur ? `${cur}\n\n${p}` : p;
      }
    }
    if (cur.trim()) out.push({ section, text: cur.trim() });
  };

  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      trail.length = level - 1;
      trail[level - 1] = h[2];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

async function listFiles(): Promise<string[]> {
  try {
    const names = await readdir(DATA_DIR);
    return names.filter((n) => /\.(md|markdown)$/i.test(n)).sort();
  } catch {
    return [];
  }
}

/**
 * Chunks every .md file in /pdf, then makes sure the persistent vector database (managed by
 * embed_server.py) holds exactly those chunks. If the files and settings are
 * unchanged since the last build, nothing is re-embedded.
 */
async function loadIndex(): Promise<Index> {
  const names = await listFiles();
  const files = await Promise.all(
    names.map(async (n) => {
      const s = await stat(path.join(DATA_DIR, n));
      return [n, s.size, Math.round(s.mtimeMs)];
    }),
  );
  // the stored vectors are reused only while the files and settings are unchanged
  const sig = JSON.stringify({ v: 4, model: MODEL, size: 900, overlap: 150, files });

  const chunks: Chunk[] = [];
  for (const name of names) {
    const md = await readFile(path.join(DATA_DIR, name), "utf8");
    for (const p of chunkMarkdown(md)) chunks.push({ doc: name, ...p });
  }
  if (chunks.length === 0) return { docs: names, chunks };

  const status = await call<{ sig: string | null; count: number }>("/status");
  if (status.sig !== sig || status.count !== chunks.length) {
    console.log(`[predii] indexing ${chunks.length} chunks into the local vector database...`);
    for (let i = 0; i < chunks.length; i += BATCH) {
      const items = chunks.slice(i, i + BATCH).map((c, j) => ({ id: i + j, ...c }));
      await call("/index", {
        items,
        reset: i === 0, // first batch wipes the old collection
        sig: i + BATCH >= chunks.length ? sig : undefined, // last batch marks it complete
      });
      console.log(`[predii] indexed ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
    }
  }
  return { docs: names, chunks };
}

export function getIndex(): Promise<Index> {
  state.index ??= loadIndex().catch((e) => {
    state.index = undefined; // let the next request retry
    throw e;
  });
  return state.index;
}

/** Top-k chunks most similar to the query, searched by the local embedding server. */
export async function search(query: string, k = 6): Promise<Hit[]> {
  const index = await getIndex();
  const { hits } = await call<{ hits: { id: number; score: number }[] }>("/search", {
    query,
    k,
  });
  return hits.map((h) => ({ chunk: index.chunks[h.id], score: h.score }));
}
