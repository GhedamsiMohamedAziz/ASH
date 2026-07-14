# Blueprint Vector DB

A local semantic-search index over the project blueprint (`../instructions.md`) —
the *Axone* multi-user AI-agent platform architecture (French, ~2 650 lines).

## What's inside

| File | Role |
|---|---|
| `ingest.py` | Parses `instructions.md` by header hierarchy, chunks, embeds, and persists to Chroma. |
| `ingest_chat.py` | Ingests a Claude Code **session transcript** (the chat) into the store. |
| `query.py` | CLI semantic search over either collection (FR / EN / AR). |
| `chroma/` | The persisted vector store (Chroma `PersistentClient`). |

- **Embeddings:** `paraphrase-multilingual-MiniLM-L12-v2` (local, offline, 384-dim, cosine) — shared by both collections.
- **Collections:**
  - `olma_blueprint` — 164 chunks from 129 blocks of `instructions.md`.
  - `olma_chat` — the session conversation (user prompts + assistant replies), one message per record, windowed. Thinking blocks, raw tool outputs and injected `<system-reminder>`/local-command wrappers are stripped. Idempotent per `session_id`.
- **Blueprint chunking:** one chunk per lowest-level section (`###`, or `##` when it has no
  sub-sections); oversized blocks (DDL, diagrams, tables) are split into
  overlapping 1 800-char windows. Navigational blocks (title, table of contents,
  `# PARTIE …` intros) are excluded. Each chunk is prefixed with its
  `Part > Section > Subsection` path and carries that path plus the section
  number and source line as metadata. Chat chunks carry `role`, `turn`, `ts`, `session_id`.

## Usage

```bash
# (Re)build the index after editing instructions.md
python3 ingest.py

# Ask questions — works in French, English, or Arabic
python3 query.py "comment un cron ré-évalue-t-il les permissions ?"
python3 query.py -n 8 "how are OAuth tokens kept out of the sandbox?"
python3 query.py --full "règles DLP sur les sorties"

# Restrict to a section number prefix (e.g. all of §15, or §9.1)
python3 query.py --section 15 "delivery des notifications"

# Ingest + search the session chat
python3 ingest_chat.py                       # newest transcript for this project
python3 query.py --chat "what did we decide about embeddings?"
```

Scores shown are cosine similarity (higher = closer). `--section` filters on the
extracted section number (`15`, `9.1`, `H`, …); `--full` prints whole chunks;
`--chat` searches the conversation instead of the blueprint. Makefile shortcuts:
`make vectordb-chat`, `make search-chat Q="…"`.

## Requirements

Python 3.10+, `chromadb`, `sentence-transformers` (pulls in `torch`). The
embedding model downloads once (~450 MB) then runs fully offline.
