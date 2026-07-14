#!/usr/bin/env python3
"""
Semantic search over the project blueprint vector DB.

Usage:
    python3 query.py "comment les permissions d'un cron sont-elles évaluées ?"
    python3 query.py -n 8 "how is prompt injection handled?"
    python3 query.py --section 15 "delivery des notifications"   # filter by section number prefix
    python3 query.py --chat "what did we decide about the vector db?"  # search the session chat

The store is multilingual, so questions work in French, English or Arabic.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import chromadb
from chromadb.utils import embedding_functions

HERE = Path(__file__).resolve().parent
DB_DIR = HERE / "chroma"
COLLECTION = "olma_blueprint"
CHAT_COLLECTION = "olma_chat"
EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def main() -> None:
    ap = argparse.ArgumentParser(description="Search the blueprint vector DB.")
    ap.add_argument("query", nargs="+", help="natural-language question")
    ap.add_argument("-n", "--top", type=int, default=5, help="number of results")
    ap.add_argument(
        "--section",
        default=None,
        help="only return chunks whose section number starts with this (e.g. 15, 9.1, H)",
    )
    ap.add_argument(
        "--full", action="store_true", help="print the full chunk text, not a preview"
    )
    ap.add_argument(
        "--chat", action="store_true", help="search the session chat instead of the blueprint"
    )
    args = ap.parse_args()
    question = " ".join(args.query)

    ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=EMBED_MODEL)
    client = chromadb.PersistentClient(path=str(DB_DIR))
    collection = client.get_collection(
        CHAT_COLLECTION if args.chat else COLLECTION, embedding_function=ef
    )

    res = collection.query(query_texts=[question], n_results=max(args.top * 3, args.top))

    ids = res["ids"][0]
    docs = res["documents"][0]
    metas = res["metadatas"][0]
    dists = res["distances"][0]

    shown = 0
    print(f'\n🔎  "{question}"\n' + "=" * 78)
    for _id, doc, meta, dist in zip(ids, docs, metas, dists):
        if args.section and not str(meta.get("number", "")).startswith(args.section):
            continue
        score = 1 - dist  # cosine similarity
        if args.chat:
            print(f"\n#{shown + 1}  ({score:.3f})  {meta.get('role', '')} · turn {meta.get('turn')}")
            print(f"     {meta.get('ts', '')}")
        else:
            print(f"\n#{shown + 1}  ({score:.3f})  {meta.get('path', '')}")
            print(f"     line {meta.get('start_line')}  ·  §{meta.get('number') or '—'}")
        body = doc.split("\n", 1)[-1] if doc.startswith("[") else doc
        if args.full:
            print("     " + body.replace("\n", "\n     "))
        else:
            preview = " ".join(body.split())[:280]
            print(f"     {preview}{'…' if len(body) > 280 else ''}")
        shown += 1
        if shown >= args.top:
            break

    if shown == 0:
        print("No results (check --section filter).")
    print()


if __name__ == "__main__":
    main()
