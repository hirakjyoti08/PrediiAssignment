import { getIndex, search } from "../../../lib/rag";
import { SYSTEM_PROMPT, buildContext } from "../../../lib/format";

export const runtime = "nodejs";
export const maxDuration = 120;

// NVIDIA's hosted API is OpenAI-compatible. Key: https://build.nvidia.com
const NVIDIA_BASE = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL ?? "nvidia/nemotron-3.5-super-vl-120b-a12b";

const NO_DOCS =
  "No markdown files found. Put your .md files in the pdf/ folder at the project root and try again.";

type Row = { component: string; spec_type: string; value: string; unit: string };

/** Pulls a non-empty JSON array of spec rows out of the model's reply, or returns null. */
function parseRows(text: string): Row[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const rows = arr
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        component: String(r.component ?? "").trim(),
        spec_type: String(r.spec_type ?? "").trim(),
        value: String(r.value ?? "").trim(),
        unit: String(r.unit ?? "").trim(),
      }))
      .filter((r) => r.component && r.value);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/** Used whenever the model returns nothing usable, so the answer is never empty. */
function notFound(question: string): Row[] {
  return [
    {
      component: question.replace(/[?.!]+$/, ""),
      spec_type: "Unknown",
      value: "Not found in document",
      unit: "",
    },
  ];
}

/** Warm-up + status: builds (or loads) the index and reports what's in it. */
export async function GET() {
  try {
    const { docs, chunks } = await getIndex();
    if (docs.length === 0) return new Response(NO_DOCS, { status: 503 });
    return Response.json({ docs, chunks: chunks.length, engine: "chroma" });
  } catch (e) {
    // e.g. the embedding server (embed_server.py) isn't running
    return new Response((e as Error).message || "Could not read documents.", { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      return new Response("NVIDIA_API_KEY is not set. Add it to .env.local and restart.", {
        status: 500,
      });
    }

    const { messages: history } = (await req.json()) as {
      messages: { role: "user" | "assistant"; content: string }[];
    };

    const index = await getIndex();
    if (index.chunks.length === 0) return new Response(NO_DOCS, { status: 503 });

    const last = history[history.length - 1];
    const question = last?.content?.trim();
    if (!question) return new Response("Empty question.", { status: 400 });

    // 1) retrieve the most relevant passages (embedded and searched in Chroma by embed_server.py)
    const prevUser =
      [...history.slice(0, -1)].reverse().find((m) => m.role === "user")?.content ?? "";
    // very short follow-ups ("and the second one?") borrow context from the previous question
    const query = question.split(/\s+/).length < 8 ? `${prevUser} ${question}` : question;
    const hits = await search(query, 6);
    console.log("[predii] hits:", hits.length, hits.map((h) => h.score.toFixed(3)).join(", "));

    // 2) final user message = retrieved passages + the question
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: `${buildContext(hits)}\n\nQuestion: ${question}` },
    ];

    // 3) ask the model. Not streamed: the answer is a small JSON array that we validate
    //    before sending, so the page can never receive an empty or broken reply.
    console.log("[predii] calling", NVIDIA_MODEL);
    const upstream = await fetch(`${NVIDIA_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages,
        max_tokens: 4096, // room for models that "think" before answering
        temperature: 0.2, // low: stay close to the retrieved text
        stream: false,
      }),
      signal: req.signal, // stops the upstream request if the user hits Stop
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      return new Response(`NVIDIA API error ${upstream.status}: ${detail.slice(0, 300)}`, {
        status: 502,
      });
    }

    const data = await upstream.json();
    const choice = data.choices?.[0];
    const content: string = choice?.message?.content ?? "";
    const reasoning: string = choice?.message?.reasoning_content ?? "";
    console.log(
      "[predii] finish:",
      choice?.finish_reason,
      "| raw output:",
      JSON.stringify(content).slice(0, 400),
    );

    // use the answer if it parses; otherwise try the reasoning text; otherwise "not found"
    const rows = parseRows(content) ?? parseRows(reasoning) ?? notFound(question);

    return new Response(JSON.stringify(rows, null, 2), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 499 });
    return new Response((e as Error).message || "Something went wrong.", { status: 500 });
  }
}