#!/usr/bin/env python3
"""
Ingest a Claude Code session transcript into the vector DB.

Stores the *actual conversation* — user prompts + assistant replies — as a
separate `olma_chat` collection in the same Chroma store as the blueprint
(`olma_blueprint`), using the same multilingual embeddings so both are
searchable. Internal `thinking` blocks, raw tool outputs, and injected
`<system-reminder>` / local-command wrappers are stripped.

Idempotent per session: re-running deletes this session's rows first.

Run:  python3 ingest_chat.py [path/to/session.jsonl]
      (defaults to the newest transcript for this project)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import chromadb
from chromadb.utils import embedding_functions

HERE = Path(__file__).resolve().parent
DB_DIR = HERE / "chroma"
COLLECTION = "olma_chat"
EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
PROJECT_TRANSCRIPTS = Path.home() / ".claude" / "projects" / "-Users-ghedamsiaziz-Desktop-olma"

MAX_CHARS = 1800
OVERLAP_CHARS = 200

# Strip injected/wrapper blocks that are not part of the human conversation.
_STRIP = [
    re.compile(r"<system-reminder>.*?</system-reminder>", re.S),
    re.compile(r"<local-command-[^>]*>.*?</local-command-[^>]*>", re.S),
    re.compile(r"<command-[^>]*>.*?</command-[^>]*>", re.S),
    re.compile(r"<bash-[^>]*>.*?</bash-[^>]*>", re.S),
    re.compile(r"\[SYSTEM NOTIFICATION.*?</task-notification>", re.S),
    re.compile(r"<task-notification>.*?</task-notification>", re.S),
]


def newest_transcript() -> Path:
    files = sorted(PROJECT_TRANSCRIPTS.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    if not files:
        sys.exit(f"No transcript found under {PROJECT_TRANSCRIPTS}")
    return files[-1]


def clean_user(text: str) -> str:
    for rx in _STRIP:
        text = rx.sub("", text)
    return text.strip()


def user_text(content) -> str:
    """User content is a str or a list of blocks; keep only real text."""
    if isinstance(content, str):
        return clean_user(content)
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return clean_user("\n".join(parts))
    return ""


def assistant_text(content) -> tuple[str, list[str]]:
    """Assistant content is a list of blocks: keep text, note tool_use names, drop thinking."""
    if not isinstance(content, list):
        return (str(content).strip(), [])
    texts, tools = [], []
    for b in content:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            texts.append(b.get("text", ""))
        elif b.get("type") == "tool_use":
            tools.append(b.get("name", "tool"))
    return ("\n".join(t for t in texts if t).strip(), tools)


def window(text: str):
    if len(text) <= MAX_CHARS:
        return [text]
    out, start = [], 0
    while start < len(text):
        end = start + MAX_CHARS
        if end >= len(text):
            out.append(text[start:]); break
        brk = text.rfind("\n", start + int(MAX_CHARS * 0.75), end)
        brk = brk if brk != -1 else end
        out.append(text[start:brk]); start = max(brk - OVERLAP_CHARS, start + 1)
    return [w.strip() for w in out if w.strip()]


def build_messages(path: Path) -> list[dict]:
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    session_id = next((r.get("sessionId") for r in rows if r.get("sessionId")), path.stem)
    msgs: list[dict] = []
    turn = 0
    for r in rows:
        if r.get("type") not in ("user", "assistant") or r.get("isMeta"):
            continue
        m = r.get("message")
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        ts = r.get("timestamp", "")
        if role == "user":
            text = user_text(m.get("content"))
            if not text:
                continue  # pure tool-result / injected noise
            turn += 1
            msgs.append({"role": "user", "turn": turn, "text": text, "ts": ts})
        elif role == "assistant":
            text, tools = assistant_text(m.get("content"))
            if not text:
                continue  # thinking-only / tool-only step
            if tools:
                text += f"\n\n[tools used: {', '.join(dict.fromkeys(tools))}]"
            msgs.append({"role": "assistant", "turn": turn, "text": text, "ts": ts})
    return session_id, msgs


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else newest_transcript()
    session_id, msgs = build_messages(path)
    print(f"Transcript: {path.name}\nSession: {session_id}\nMessages kept: {len(msgs)}")

    ids, docs, metas = [], [], []
    for i, m in enumerate(msgs):
        for j, piece in enumerate(window(m["text"])):
            prefix = f"[{m['role']} · turn {m['turn']}]\n"
            ids.append(f"{session_id[:8]}-{i:04d}-{j}")
            docs.append(prefix + piece)
            metas.append({
                "session_id": session_id, "role": m["role"], "turn": m["turn"],
                "ts": m["ts"], "seq": i, "chunk": j,
            })
    print(f"Chunks: {len(docs)}")

    ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=EMBED_MODEL)
    client = chromadb.PersistentClient(path=str(DB_DIR))
    collection = client.get_or_create_collection(
        COLLECTION, embedding_function=ef, metadata={"hnsw:space": "cosine"}
    )
    # Idempotent per session: clear this session's rows, then insert.
    try:
        collection.delete(where={"session_id": session_id})
    except Exception:
        pass

    B = 64
    for s in range(0, len(docs), B):
        collection.add(ids=ids[s:s+B], documents=docs[s:s+B], metadatas=metas[s:s+B])
        print(f"  indexed {min(s+B, len(docs))}/{len(docs)}", end="\r")
    print(f"\nDone. Collection '{COLLECTION}' now holds {collection.count()} chunks.")


if __name__ == "__main__":
    main()
