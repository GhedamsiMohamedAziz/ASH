"""Memory — working + semantic + hybrid retrieval (instructions.md §9.1).

This is the Memory stage of the pipeline (§9). It implements:
  • WorkingMemory (type 1, §9.1): a 30-turn window + rolling summary (Redis in prod).
  • MemoryStore (types 2/4, §9.1): durable facts/corrections in a vector store with
    cosine-dedup (> 0.92) and the hybrid retrieval ranking (§9.1). pgvector in prod.
  • hygiene guards (§9.1.3): DLP + no third-party facts (checked by the caller).

Embeddings are pluggable: a deterministic hashing embedder is used offline/in tests;
prod plugs a real model (VECTOR(1024), §16.1). Only cosine matters to the logic.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import deque
from dataclasses import dataclass, field

# ---------------------------------------------------------------- embeddings
DIM = 256


_WORD_WEIGHT = 3.0   # whole-word match dominates
_TRIGRAM_WEIGHT = 1.0  # morphology (deploy/deployment) contributes weakly

# Common stopwords drop out so signal words dominate the cosine (both languages).
_STOP = frozenset(
    "the a an is are was to of in on at for and or we do how what our my your it "
    "le la les un une de des du et ou à en sur pour est sont ce mes".split()
)


def _features(text: str):
    """(feature, weight): content words weigh more than char trigrams; stopwords dropped."""
    for tok in re.findall(r"\w+", text.lower()):
        if tok in _STOP:
            continue
        yield tok, _WORD_WEIGHT
        padded = f" {tok} "
        for i in range(len(padded) - 2):
            yield padded[i : i + 3], _TRIGRAM_WEIGHT


def embed(text: str) -> list[float]:
    """Deterministic hashing embedding (weighted words + char trigrams), L2-normalized.

    Real cosine geometry (shared words/morphology → high similarity) with no
    dependency or network — good enough for dedup + ranking tests. Prod swaps a
    real model (VECTOR(1024), §16.1); only cosine matters to the logic here.
    """
    vec = [0.0] * DIM
    for feat, w in _features(text):
        h = int(hashlib.md5(feat.encode()).hexdigest(), 16)
        vec[h % DIM] += w
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))  # both are unit vectors


# ---------------------------------------------------------------- working memory (type 1)
class WorkingMemory:
    """Rolling window of the last N turns + a summary regenerated every K turns (§9.1)."""

    def __init__(self, window: int = 30, summary_every: int = 15) -> None:
        self.turns: deque[str] = deque(maxlen=window)
        self.summary = ""
        self._since_summary = 0
        self._summary_every = summary_every

    def add_turn(self, text: str) -> bool:
        """Append a turn. Returns True when a summary regeneration is due."""
        self.turns.append(text)
        self._since_summary += 1
        if self._since_summary >= self._summary_every:
            self._since_summary = 0
            return True
        return False

    def set_summary(self, summary: str) -> None:
        self.summary = summary


# ---------------------------------------------------------------- semantic memory (types 2/4)
@dataclass
class Memory:
    id: str
    content: str
    kind: str  # fact|preference|procedure|correction
    embedding: list[float]
    created_at: float
    use_count: int = 0
    expires_at: float | None = None


@dataclass
class MemoryStore:
    """Vector store with cosine dedup + hybrid ranking (§9.1). pgvector in prod."""

    # 0.55 is the §9.1 prod default, tuned for a real embedding model (cosine 0.6-0.8
    # for related text). The deterministic test embedder has a compressed cosine
    # range, so tests construct the store with a lower recall_threshold.
    dedup_threshold: float = 0.92
    recall_threshold: float = 0.55
    top_k: int = 8
    halflife_days: float = 30.0
    _items: list[Memory] = field(default_factory=list)
    _seq: int = 0

    def save(self, content: str, kind: str, now: float, expires_at: float | None = None) -> Memory | None:
        """Save a fact; returns None if a near-duplicate already exists (§9.1 dedup)."""
        emb = embed(content)
        for m in self._items:
            if cosine(emb, m.embedding) > self.dedup_threshold:
                m.use_count += 1  # reinforce the existing one instead
                return None
        self._seq += 1
        mem = Memory(f"mem_{self._seq:06d}", content, kind, emb, now, expires_at=expires_at)
        self._items.append(mem)
        return mem

    def _score(self, m: Memory, query_emb: list[float], now: float) -> float:
        # Hybrid: 0.65 cosine + 0.20 recency + 0.15 frequency (+0.15 correction bonus).
        cos = cosine(query_emb, m.embedding)
        age_days = max(0.0, (now - m.created_at) / 86400.0)
        recency = 0.5 ** (age_days / self.halflife_days)
        freq = min(1.0, m.use_count / 10.0)
        score = 0.65 * cos + 0.20 * recency + 0.15 * freq
        if m.kind == "correction":
            score += 0.15
        return score

    def search(self, query: str, now: float, kinds: list[str] | None = None) -> list[tuple[Memory, float]]:
        """Top-k by hybrid score, above the recall threshold; purges expired (§9.1)."""
        self._items = [m for m in self._items if m.expires_at is None or m.expires_at > now]
        q = embed(query)
        scored = []
        for m in self._items:
            if kinds and m.kind not in kinds:
                continue
            s = self._score(m, q, now)
            if s >= self.recall_threshold:
                scored.append((m, s))
        scored.sort(key=lambda t: t[1], reverse=True)
        for m, _ in scored[: self.top_k]:
            m.use_count += 1  # usage frequency feeds future ranking
        return scored[: self.top_k]

    def update(self, memory_id: str, content: str) -> Memory | None:
        for m in self._items:
            if m.id == memory_id:
                m.content, m.embedding = content, embed(content)  # old archived in prod (§9.1.1)
                return m
        return None

    def forget(self, memory_id: str) -> bool:
        before = len(self._items)
        self._items = [m for m in self._items if m.id != memory_id]
        return len(self._items) < before

    def all(self) -> list[Memory]:
        return list(self._items)
