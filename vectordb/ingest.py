#!/usr/bin/env python3
"""
Ingest the project blueprint (instructions.md) into a persistent Chroma vector DB.

Strategy
--------
1. Parse the Markdown into a header hierarchy (# PARTIE / ## Section / ### Sub-section).
2. Build one logical chunk per lowest-level header block, carrying its full
   ancestor path (part > section > subsection) as metadata + a context prefix.
3. Split oversized blocks (DDL dumps, diagrams, long tables) into overlapping
   windows so no single embedding input is too long.
4. Embed with a multilingual model (good on the French/Arabic source text).
5. Persist to ./chroma with rich metadata for filtered retrieval.

Run:  python3 ingest.py            # (re)build the DB
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import chromadb
from chromadb.utils import embedding_functions

# ---------------------------------------------------------------- config
HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "instructions.md"
DB_DIR = HERE / "chroma"
COLLECTION = "olma_blueprint"
EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

# Chunk sizing (characters). Blocks larger than MAX are windowed.
MAX_CHARS = 1800
OVERLAP_CHARS = 200
MIN_CHARS = 40  # skip near-empty blocks


# ---------------------------------------------------------------- parsing
HEADER_RE = re.compile(r"^(#{1,3})\s+(.*)$")
# A "section number" like 9.1.2 / 15.8 / H.4 / E.3 at the start of a title.
NUM_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)*|[A-Z](?:\.[0-9]+)*)\b")


@dataclass
class Block:
    part: str
    section: str
    subsection: str
    title: str          # the deepest header title
    number: str         # extracted section number, if any
    start_line: int
    lines: list[str] = field(default_factory=list)

    @property
    def body(self) -> str:
        return "\n".join(self.lines).strip()

    @property
    def path(self) -> str:
        parts = [p for p in (self.part, self.section, self.subsection) if p]
        return " > ".join(parts)


def parse_blocks(text: str) -> list[Block]:
    """Walk the doc, emitting a Block each time a new header opens.

    Content under a header belongs to that header until the next header of any
    level. We keep the current part/section/subsection context as we descend.
    """
    part = section = subsection = ""
    blocks: list[Block] = []
    current: Block | None = None

    for i, line in enumerate(text.splitlines(), start=1):
        m = HEADER_RE.match(line)
        if not m:
            if current is not None:
                current.lines.append(line)
            continue

        # flush the block that was accumulating
        if current is not None:
            blocks.append(current)

        level = len(m.group(1))
        title = m.group(2).strip()

        if level == 1:
            part = title
            section = subsection = ""
        elif level == 2:
            section = title
            subsection = ""
        else:  # level == 3
            subsection = title

        deepest = subsection or section or part
        num_match = NUM_RE.match(deepest)
        number = num_match.group(1) if num_match else ""

        current = Block(
            part=part,
            section=section,
            subsection=subsection,
            title=deepest,
            number=number,
            start_line=i,
        )

    if current is not None:
        blocks.append(current)
    return blocks


def window(text: str, size: int, overlap: int) -> list[str]:
    """Split text into overlapping windows on paragraph/line boundaries."""
    if len(text) <= size:
        return [text]
    out: list[str] = []
    start = 0
    while start < len(text):
        end = start + size
        if end >= len(text):
            out.append(text[start:])
            break
        # try to break on a newline within the last 25% of the window
        brk = text.rfind("\n", start + int(size * 0.75), end)
        if brk == -1:
            brk = end
        out.append(text[start:brk])
        start = max(brk - overlap, start + 1)
    return [w.strip() for w in out if w.strip()]


# ---------------------------------------------------------------- build
def build() -> None:
    if not SOURCE.exists():
        sys.exit(f"Source not found: {SOURCE}")

    text = SOURCE.read_text(encoding="utf-8")
    blocks = [
        b
        for b in parse_blocks(text)
        # Keep only real content: a block must live under a ## section.
        # This drops the doc title, the table of contents, and the
        # navigational "# PARTIE …" intro blocks (pure boilerplate noise).
        if b.section and len(b.body) >= MIN_CHARS and "Table des matières" not in b.section
    ]
    print(f"Parsed {len(blocks)} content blocks from {SOURCE.name}")

    ids: list[str] = []
    docs: list[str] = []
    metas: list[dict] = []

    for b in blocks:
        pieces = window(b.body, MAX_CHARS, OVERLAP_CHARS)
        for j, piece in enumerate(pieces):
            # Prefix the ancestor path so the embedding "knows" where it lives.
            context = f"[{b.path}]\n{piece}"
            cid = f"{b.start_line:05d}-{j}"
            ids.append(cid)
            docs.append(context)
            metas.append(
                {
                    "part": b.part,
                    "section": b.section,
                    "subsection": b.subsection,
                    "title": b.title,
                    "number": b.number,
                    "path": b.path,
                    "start_line": b.start_line,
                    "chunk": j,
                    "n_chunks": len(pieces),
                }
            )

    print(f"Produced {len(docs)} chunks (after windowing).")

    # Fresh collection each build for reproducibility.
    client = chromadb.PersistentClient(path=str(DB_DIR))
    try:
        client.delete_collection(COLLECTION)
    except Exception:
        pass

    print(f"Loading embedding model: {EMBED_MODEL} ...")
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=EMBED_MODEL
    )
    collection = client.create_collection(
        name=COLLECTION,
        embedding_function=ef,
        metadata={"source": SOURCE.name, "model": EMBED_MODEL, "hnsw:space": "cosine"},
    )

    # Embed + insert in batches.
    B = 64
    for start in range(0, len(docs), B):
        collection.add(
            ids=ids[start : start + B],
            documents=docs[start : start + B],
            metadatas=metas[start : start + B],
        )
        print(f"  indexed {min(start + B, len(docs))}/{len(docs)}", end="\r")

    print(f"\nDone. Collection '{COLLECTION}' holds {collection.count()} chunks.")
    print(f"Persisted at: {DB_DIR}")


if __name__ == "__main__":
    build()
