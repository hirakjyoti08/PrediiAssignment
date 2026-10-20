"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type Kb =
  | { state: "loading" }
  | { state: "ready"; docs: string[]; chunks: number }
  | { state: "error"; message: string };

const uid = () => Math.random().toString(36).slice(2, 10);

const STARTERS = [
  "Torque for brake caliper bolts",
  "Torque specs for front brake caliper bolts",
  "How to bleed the brake system",
  "Front suspension lower arm removal steps",
  "Wheel bearing torque specification",
  "Stabilizer bar link removal and installation"
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [kb, setKb] = useState<Kb>({ state: "loading" });

  const taRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stick = useRef(true);

  // warm up: the server reads, embeds and caches the PDF(s) before the first question
  useEffect(() => {
    let alive = true;
    fetch("/api/chat")
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.text()) || "Could not read documents.");
        return res.json();
      })
      .then((d) => alive && setKb({ state: "ready", docs: d.docs, chunks: d.chunks }))
      .catch((e: Error) => alive && setKb({ state: "error", message: e.message }));
    return () => {
      alive = false;
    };
  }, []);

  // keep pinned to the bottom unless the reader scrolled up
  useEffect(() => {
    if (stick.current) {
      endRef.current?.scrollIntoView({ behavior: loading ? "auto" : "smooth", block: "end" });
    }
  }, [messages, loading]);

  const resize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, []);

  useEffect(() => {
    resize();
  }, [input, resize]);

  useEffect(() => {
    document.fonts?.ready.then(resize);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading || kb.state === "error") return;

    const userMsg: Message = { id: uid(), role: "user", content };
    const assistantId = uid();
    const history = [...messages, userMsg];

    stick.current = true;
    setShowJump(false);
    setMessages([...history, { id: assistantId, role: "assistant", content: "" }]);
    setInput("");
    setLoading(true);
    setError(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.text()) || "Request failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) =>
          m.map((x) => (x.id === assistantId ? { ...x, content: acc } : x)),
        );
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message || "Something went wrong.");
        setMessages((m) => m.filter((x) => x.id !== assistantId || x.content));
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  const stop = () => abortRef.current?.abort();

  const newChat = () => {
    stop();
    setMessages([]);
    setError(null);
    setShowJump(false);
    stick.current = true;
  };

  const jumpDown = () => {
    stick.current = true;
    setShowJump(false);
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const canSend = input.trim().length > 0 && kb.state !== "error";

  const kbLabel =
    kb.state === "loading"
      ? "Reading document…"
      : kb.state === "error"
        ? "No document"
        : `${kb.docs.length} ${kb.docs.length === 1 ? "document" : "documents"} · ${kb.chunks} passages`;

  return (
    <div className="relative flex h-full flex-col">
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 -z-0" />

      {/* Header */}
      <header className="relative z-10 flex items-center justify-between border-b border-line bg-paper/70 px-5 py-3.5 backdrop-blur-md sm:px-8">
        <div className="flex items-center gap-2.5">
          <span className="relative grid size-2.5 place-items-center">
            {loading && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
            )}
            <span className="relative size-2.5 rounded-full bg-accent" />
          </span>
          <span className="font-serif text-xl tracking-tight">Predii</span>
        </div>
        <button
          onClick={newChat}
          className="rounded-full border border-line px-3.5 py-1.5 text-[13px] text-muted transition-all duration-200 hover:border-ink/25 hover:text-ink active:scale-95"
        >
          New chat
        </button>
      </header>

      {/* Messages */}
      <div className="relative z-[1] min-h-0 flex-1">
        <main
          className="absolute inset-0 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            stick.current = near;
            setShowJump(!near);
          }}
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-7 px-5 py-10 sm:px-6">
            {messages.length === 0 ? (
              <div className="pt-[8vh]">
                <h1 className="animate-fade-up font-serif text-[36px] leading-[1.1] tracking-tight sm:text-[46px]">
                  Ask anything
                  <br />
                  about the document.
                </h1>

                <div
                  className="mt-4 min-h-[44px] max-w-md animate-fade-up text-[15px] leading-relaxed text-muted"
                  style={{ animationDelay: "90ms" }}
                >
                  {kb.state === "loading" && (
                    <span className="animate-pulse">Reading and indexing the document…</span>
                  )}
                  {kb.state === "ready" && (
                    <p>
                      Document ready.
                    </p>
                  )}
                  {kb.state === "error" && (
                    <p className="border-l-2 border-red-600 pl-3 text-[13px] text-red-700 dark:border-red-400 dark:text-red-400">
                      {kb.message}
                    </p>
                  )}
                </div>

                <ul className="mt-10 divide-y divide-line border-y border-line">
                  {STARTERS.map((s, i) => (
                    <li
                      key={s}
                      className="animate-fade-up"
                      style={{ animationDelay: `${200 + i * 70}ms` }}
                    >
                      <button
                        onClick={() => {
                          setInput(s);
                          taRef.current?.focus();
                        }}
                        className="group flex w-full items-center justify-between py-3.5 text-left text-[15px] text-ink/75 transition-colors hover:text-ink"
                      >
                        <span className="transition-transform duration-300 group-hover:translate-x-1">
                          {s}
                        </span>
                        <span className="text-muted transition-all duration-300 group-hover:translate-x-1 group-hover:text-accent">
                          →
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              messages.map((m, i) => (
                <Entry
                  key={m.id}
                  m={m}
                  typing={loading && i === messages.length - 1 && m.role === "assistant"}
                />
              ))
            )}
            <div ref={endRef} />
          </div>
        </main>

        {showJump && (
          <button
            onClick={jumpDown}
            aria-label="Scroll to latest"
            className="absolute bottom-3 left-1/2 z-10 grid size-9 -translate-x-1/2 animate-pop-in place-items-center rounded-full border border-line bg-surface shadow-md transition hover:border-ink/25 active:scale-90"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Composer */}
      <footer className="relative z-10 px-5 pb-5 pt-2 sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          {error && (
            <p className="mb-3 animate-fade-up border-l-2 border-red-600 pl-3 text-[13px] text-red-700 dark:border-red-400 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-16px_rgb(0_0_0/0.18)] transition-all duration-300 focus-within:border-accent/60 focus-within:shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_14%,transparent),0_12px_32px_-16px_rgb(0_0_0/0.2)]">
            <textarea
              ref={taRef}
              value={input}
              rows={1}
              placeholder="Ask a question about the document"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              className="block min-h-[60px] max-h-[200px] w-full resize-none overflow-y-auto bg-transparent px-4 pb-2 pt-4 text-[15px] leading-6 outline-none placeholder:text-muted"
            />

            <div className="flex items-center justify-between px-4 pb-2.5 pt-1">
              <span className="flex items-center gap-2 text-[12px] text-muted">
                <span
                  className={`size-1.5 rounded-full ${
                    kb.state === "ready"
                      ? "bg-accent"
                      : kb.state === "error"
                        ? "bg-red-500"
                        : "animate-pulse bg-muted"
                  }`}
                />
                {kbLabel}
              </span>

              <div className="flex items-center gap-3">
                <span
                  className={`hidden font-mono text-[11px] text-muted transition-opacity duration-300 sm:inline ${canSend ? "opacity-100" : "opacity-0"}`}
                >
                  ↵ to send
                </span>

                {loading ? (
                  <button
                    onClick={stop}
                    aria-label="Stop generating"
                    className="relative grid size-9 animate-pop-in place-items-center rounded-full border border-line transition active:scale-90"
                  >
                    <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-accent" />
                    <span className="size-2.5 rounded-[3px] bg-ink" />
                  </button>
                ) : (
                  <button
                    onClick={() => send()}
                    disabled={!canSend}
                    aria-label="Send"
                    className={`grid size-9 place-items-center rounded-full bg-accent text-accent-ink transition-all duration-300 ease-[cubic-bezier(0.2,0.9,0.3,1.3)] ${
                      canSend
                        ? "scale-100 opacity-100 hover:-translate-y-0.5 active:scale-90"
                        : "scale-75 opacity-30"
                    }`}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Entry({ m, typing }: { m: Message; typing: boolean }) {
  const isUser = m.role === "user";

  return (
    <div
      className={`flex animate-fade-up flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}
    >
      {isUser ? (
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[15px] leading-relaxed text-paper">
          {m.content}
        </p>
      ) : (
        <div className="w-full whitespace-pre-wrap text-[15.5px] leading-7">
          {m.content}
          {typing && !m.content && (
            <span className="inline-flex items-center gap-1 py-2">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-1.5 animate-dot rounded-full bg-accent"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </span>
          )}
          {typing && m.content && (
            <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] animate-blink bg-accent" />
          )}
        </div>
      )}
    </div>
  );
}