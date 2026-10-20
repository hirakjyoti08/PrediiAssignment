"""Local embedding + vector database server for rag.ts (sentence-transformers + Chroma).

Install:  pip install sentence-transformers chromadb fastapi uvicorn
Run:      source /tmp/predii-venv/bin/activate
          uvicorn embed_server:app --port 8001

Vectors are stored on disk in ./chroma_db (next to this file) and survive restarts.
"""
from pathlib import Path

import chromadb
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL = "BAAI/bge-base-en-v1.5"
# BGE is trained so that queries get this prefix and passages do not.
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

DB_DIR = Path(__file__).parent / "chroma_db"
SIG_FILE = DB_DIR / "signature.txt"  # written only after a full, successful index build
COLLECTION = "predii"

DB_DIR.mkdir(exist_ok=True)
model = SentenceTransformer(MODEL)  # add device="cuda" if you have a GPU
client = chromadb.PersistentClient(path=str(DB_DIR))
app = FastAPI()


def collection():
    # cosine space: distance = 1 - cosine similarity
    return client.get_or_create_collection(COLLECTION, metadata={"hnsw:space": "cosine"})


class Item(BaseModel):
    id: int
    doc: str
    section: str
    text: str


class IndexReq(BaseModel):
    items: list[Item]
    reset: bool = False  # true on the first batch: wipes the old collection
    sig: str | None = None  # sent with the last batch: marks the index as complete


class SearchReq(BaseModel):
    query: str
    k: int = 6


@app.get("/health")
def health():
    return {"model": MODEL, "dim": model.get_sentence_embedding_dimension()}


@app.get("/status")
def status():
    sig = SIG_FILE.read_text() if SIG_FILE.exists() else None
    return {"sig": sig, "count": collection().count()}


@app.post("/index")
def index(req: IndexReq):
    if req.reset:
        SIG_FILE.unlink(missing_ok=True)
        try:
            client.delete_collection(COLLECTION)
        except Exception:
            pass  # nothing to delete yet

    if req.items:
        # embed the heading together with the text so the section title helps retrieval
        texts = [f"{i.section}\n{i.text}" if i.section else i.text for i in req.items]
        vecs = model.encode(texts, batch_size=32, normalize_embeddings=True)
        collection().add(
            ids=[str(i.id) for i in req.items],
            embeddings=vecs.tolist(),
            documents=[i.text for i in req.items],
            metadatas=[{"doc": i.doc, "section": i.section} for i in req.items],
        )

    if req.sig is not None:
        SIG_FILE.write_text(req.sig)
    return {"count": collection().count()}


@app.post("/search")
def search(req: SearchReq):
    col = collection()
    n = col.count()
    if n == 0:
        return {"hits": []}
    q = model.encode([QUERY_PREFIX + req.query], normalize_embeddings=True)
    res = col.query(
        query_embeddings=q.tolist(),
        n_results=min(req.k, n),
        include=["distances"],
    )
    return {
        "hits": [
            {"id": int(i), "score": 1 - d}
            for i, d in zip(res["ids"][0], res["distances"][0])
        ]
    }