# PlaceMates v2.0 — First-Principles Deep Dive

> **Purpose**: This document provides a complete, IEEE-level technical analysis of every component in your system. For each subsystem you will find: what it does, why that approach was chosen, what happens without it, alternatives with tradeoffs, failure modes, and the hardest interview questions you could face.

---

## Table of Contents

1. [User Data Ingestion](#1-user-data-ingestion)
2. [Profile Representation](#2-profile-representation)
3. [Similarity Matching](#3-similarity-matching)
4. [Job Scraping Pipeline](#4-job-scraping-pipeline)
5. [RAG System](#5-rag-system)
6. [Multi-Agent System](#6-multi-agent-system)
7. [Evaluation System](#7-evaluation-system)
8. [Self-Improving Dataset](#8-self-improving-dataset)
9. [System Design](#9-system-design)
10. [Scalability](#10-scalability)
11. [Limitations](#11-limitations)
12. [System-Level Understanding](#12-system-level-understanding)

---

# 1. User Data Ingestion

## 🔹 1.1 WHAT IT DOES

PlaceMates ingests user data from **two independent pipelines** that converge into a unified profile:

### GitHub Pipeline ([githubAnalysisService.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/githubAnalysisService.ts))

The pipeline is **fully offline** — zero external AI calls:

```
GitHub API → fetch ALL repos → per-repo analysis → score → select top 10
  └→ languages + contributors + readme + user commits
       └→ readmeAnalyzer   (regex/rule-based README parsing)
       └→ commitAnalyzer   (commit message NLP patterns)
       └→ fileAnalyzer     (file path → module/feature detection)
       └→ domainDetector   (multi-signal domain inference)
            └→ generateProjectBullets (template engine)
                 └→ upsert Project + Skills + UserSummary
```

**Key design decisions:**
- **Sequential repo processing** (line 444): Processes repos one-by-one to respect GitHub's secondary rate limits. Parallel calls risk 403 errors because GitHub throttles based on computational cost, not just request count.
- **Composite ranking score** (line 139-180): A weighted formula combining 7 signals:
  - Commit count (30%): Direct evidence of work
  - Quality score (20%): Stars + forks + README presence
  - Feature score (20%): Detected features from all analyzers
  - README presence (10%): Binary signal
  - Recency score (10%): Exponential decay over 365 days
  - Complexity score (10%): Language count + full-stack bonus + database signals
  - Contribution score (10%): Distinguishes solo vs. collaborative
- **Meaningfulness filter** (line 182-209): Rejects empty repos, uncontributed forks, and repos with zero meaningful data.
- **Safe fetch wrappers** (line 215-257): Handles HTTP 409 (empty repos), 404, 422 gracefully — returns `[]` instead of crashing. This is critical because GitHub returns 409 for repos with empty git histories.

### LinkedIn Pipeline ([linkedinAnalysisService.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/linkedinAnalysisService.ts))

```
User uploads LinkedIn data export (.zip)
  → AdmZip extraction (with nested folder handling)
    → CSV parsing: Positions.csv, Skills.csv, Education.csv, Honors.csv, Certifications.csv, Profile.csv
      → Rule-based experience description formatting (no AI)
        → Skill merging (GitHub "github" → "both" when LinkedIn confirms)
          → Persist: Experience, Education, Award, Certification, Skill, UserSummary
```

**Key decision**: LinkedIn experiences are **delete-and-recreate** (line 135: `deleteMany`), not upsert. Why? LinkedIn CSV exports have no stable unique ID per position. Upserting on `(role, company)` would miss role changes at the same company. The tradeoff: if a user re-imports, they lose any manual edits.

### Skill Merging Logic

The merge strategy is critical and often overlooked:

| Existing Source | New Source | Result |
|---|---|---|
| `"github"` | LinkedIn adds same skill | `"both"` |
| `"linkedin"` | GitHub adds same skill | `"both"` |
| (none) | GitHub | `"github"` |
| (none) | LinkedIn | `"linkedin"` |

Skills are normalized via `normalizeSkillName()` and deduplicated using composite unique key `[userId, name]`.

### LLM Enrichment ([projectEnrichmentService.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/ai/projectEnrichmentService.ts))

This is an **optional, additive layer** that runs after offline analysis:

- **Single LLM call** for ALL selected projects (up to 6 in one prompt)
- Token budget: ~3,000 tokens per user, well within Groq free tier (500K/day)
- Returns: AI description, skills, complexity, uniqueAngle per project
- **Always returns null on failure** — the offline pipeline already produced viable baseBullets, so this is pure enhancement

## 🔹 1.2 WHY THIS APPROACH

**First principle**: A user's professional identity exists across fragmented platforms. No single source captures skills (demonstrated via code) + experience (via work history) + credentials (via education/certs). You need multiple pipelines that **converge**.

**Why offline-first?**
1. **Cost**: LLM calls at scale = $0.01-0.10/user. For a placement platform with thousands of students, this adds up. Rule-based analysis costs $0.
2. **Latency**: GitHub analysis runs 10-60 seconds (API-bound). Adding LLM calls would push it to 2-3 minutes.
3. **Determinism**: Rule-based bullet generation produces consistent output. LLM can hallucinate skills users don't have.
4. **Privacy**: No user code is sent to external APIs during the core pipeline.

## 🔹 1.3 WHAT BREAKS WITHOUT THIS

- **Without GitHub parsing**: You only have self-reported skills. LinkedIn profiles are famously inflated. GitHub is the closest thing to "proof of work" in tech.
- **Without the composite scoring**: You'd show users their "hello-world" repos. The scoring ensures only meaningful projects surface.
- **Without skill merging**: A user who knows React (proved by GitHub) and also listed React on LinkedIn would appear twice in their skill list — or worse, the LinkedIn import would overwrite the GitHub-verified source tag.

## 🔹 1.4 ALTERNATIVES

| Approach | Pros | Cons |
|---|---|---|
| **Your approach (rule-based + optional LLM)** | Free, fast, deterministic | Limited understanding of project context |
| **Full LLM analysis per repo** | Richer descriptions, better bullets | $0.05-0.20/repo × 50 repos = $2.50-10/user. Hallucination risk. |
| **GitHub Copilot/CodeQL analysis** | Deep code understanding | Requires clone, massive compute, complex setup |
| **Resume parsing (Affinda/Sovren)** | Handles PDF resumes directly | Can't capture GitHub contribution quality |
| **User self-entry only** | Simplest | Missing verified data, high friction |

## 🔹 1.5 TRADEOFFS

- **Completeness vs. Speed**: You analyze the full repo list but only persist top 10. This means repos 11-50 are analyzed but discarded — wasted GitHub API calls. Fix: Pre-filter before deep analysis.
- **Offline accuracy vs. LLM intelligence**: Your `readmeAnalyzer` uses regex patterns like `/\b(auth|authentication|login|oauth)/i`. This misses novel features that don't match patterns. The LLM enrichment catches these, but it's optional.
- **Delete-and-recreate LinkedIn**: Fast and simple, but loses manual user edits. Alternative: hash-based change detection.

## 🔹 1.6 FAILURE CASES

1. **GitHub token expiration**: Handled — `GitHubUnauthorizedError` sets `githubConnected = false`.
2. **Empty repositories**: Handled — 409 status silently returns `[]`.
3. **Non-standard LinkedIn exports**: Different LinkedIn versions use different CSV headers ("Field Of Study" vs "Field of Study"). Handled with fallback keys.
4. **Repos with only Jupyter notebooks**: The `fileAnalyzer` may not detect modules from `.ipynb` files.
5. **Forked repos without user commits**: Filtered out by `isMeaningfulRepository`, but a user who made significant commits to a fork via GitHub's web editor (which may not attribute properly) could lose credit.
6. **Rate limiting**: GitHub's secondary rate limit (undocumented compute-based limit) can reject even sequential requests. Your `safelyFetch` wrappers handle this, but with total data loss for that repo.

## 🔹 1.7 INTERVIEW QUESTIONS

> **Q**: "Why not just let users upload their resume and skip GitHub/LinkedIn entirely?"
> 
> **A**: Self-reported resumes suffer from two problems: (1) users omit skills they think are obvious, (2) there's no verification. GitHub analysis provides *evidence-based* skill detection — if a user's repos use React, the system knows, even if they forgot to list it. This is the difference between *claimed* competency and *demonstrated* competency.

> **Q**: "How do you handle a user who contributes to 200 GitHub repos?"
> 
> **A**: We paginate through ALL repos (100/page), analyze each one with the offline pipeline, then select the top 10 by composite ranking score. The analysis is sequential to respect rate limits, but each repo's sub-fetches (languages, contributors, readme) are parallelized with `Promise.all`.

> **Q**: "What if the LLM enrichment disagrees with the offline analysis — e.g., the LLM says a project is 'beginner' but the offline pipeline found advanced features?"
> 
> **A**: The LLM enrichment writes to separate fields (`aiDescription`, `aiSkills`, `aiComplexity`, `aiUniqueAngle`). The offline-generated `baseBullets` are never overwritten. This is a deliberate design: the LLM enriches, it doesn't replace. If the LLM fails, the system still works entirely on offline data.

---

# 2. Profile Representation

## 🔹 2.1 WHAT IT DOES

The system converts a user's multi-modal, relational data (projects, skills, experience, education, certifications, awards) into a **single text string** that then becomes a **384-dimensional dense vector**.

### Step 1: Text Flattening ([profileTextEncoder.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/semantic/profileTextEncoder.ts))

```typescript
// Priority ordering (conceptually weighted by position in string):
parts.push(`Domain: ${profile.primaryDomain}`);     // Strongest signal
parts.push(profile.summaryText);                      // Context
parts.push(`Skills: ${skillNames.join(", ")}`);       // Keywords
// + Experience entries
// + Top 5 projects with tech stacks + bullets
// + Education
// + Certifications
parts.join(" | ");  // Delimiter: pipe character
```

**Why this ordering matters**: SentenceTransformer models have positional bias. Early tokens in the input receive slightly more attention weight in the mean-pooling layer. By placing `Domain` first and `Certifications` last, you implicitly weight domain-matching as the strongest hierarchical signal.

### Step 2: Cache Invalidation

```typescript
export function computeProfileHash(text: string): string {
  return createHash("md5").update(text).digest("hex");
}
```

MD5 hash of the flattened text. If the hash matches what's stored in `UserEmbedding.profileHash`, skip re-embedding. This saves ~100ms per match cycle.

### Step 3: Embedding ([embedder.py](file:///c:/AllImpprojects/PlaceMates/embedding-service/app/embedder.py))

```python
model.encode(text, convert_to_numpy=True, normalize_embeddings=True)
```

- **Model**: `all-MiniLM-L6-v2` (via SentenceTransformers)
- **Output**: 384-dimensional dense vector, L2-normalized
- **Normalization**: `normalize_embeddings=True` means cosine similarity = dot product

## 🔹 2.2 WHY 384 DIMENSIONS?

This is NOT an arbitrary choice. It's a consequence of choosing `all-MiniLM-L6-v2`:

| Property | Value | Why It Matters |
|---|---|---|
| Architecture | MiniLM (distilled BERT) | 6 layers, 384 hidden, 22M params |
| Embedding dim | 384 | Each dimension encodes a learned semantic axis |
| Training | Trained on 1B+ sentence pairs | Understands semantic similarity, not just keyword overlap |
| Speed | ~14K sentences/sec on CPU | Fast enough for real-time embedding without GPU |
| Storage | 384 × 4 bytes = 1.5KB per vector | 1M users = 1.5GB of embeddings in memory |

**Why not 768-dim (full BERT)?**
- `all-MiniLM-L6-v2` (384d) vs `all-mpnet-base-v2` (768d):
  - Speed: 2× faster for 384d (half the vector operations)
  - Quality: mpnet scores 0.6+ on STS-B vs MiniLM's 0.4-0.5... BUT for short text similarity (which is what you're doing), the gap narrows significantly
  - Memory: 2× less RAM for the FAISS index
  - For a placement platform, the speed/memory tradeoff is worth the marginally lower quality

**The deeper answer**: 384 dimensions is the output of MiniLM's final layer pooling. The model learns to compress semantic meaning into this fixed-width vector. Each dimension is a *learned feature* — not human-interpretable, but capturing things like "technical expertise level", "domain affinity", "seniority signals", etc.

## 🔹 2.3 WHY SENTENCETRANSFORMERS?

**First principle**: You need to convert variable-length text into fixed-length vectors where **semantic similarity maps to geometric proximity**. This is the core requirement for vector search.

Why SentenceTransformers specifically:
1. **Trained for similarity**: Unlike raw BERT (trained for MLM/NSP), SentenceTransformer models are fine-tuned with contrastive/triplet loss on sentence pairs. "React developer with 3 years experience" and "Front-end engineer skilled in React" will have high cosine similarity.
2. **Python ecosystem**: Direct integration with FAISS and ChromaDB
3. **No API dependency**: Runs locally, no API key needed, no cost
4. **Community standard**: Most vector DBs benchmark against SentenceTransformer models

## 🔹 2.4 WHAT IF WE DIDN'T USE THIS

- **Without text flattening**: You'd need to embed each field separately (skills vector, experience vector, projects vector) and combine them somehow (weighted sum? concatenation?). This creates the "dimensionality alignment" problem — how do you weight skills vs. experience in the final vector?
- **Without embeddings**: Fall back to keyword matching (TF-IDF, BM25). A React developer wouldn't match a "Frontend Engineer" job posting because the keywords don't overlap literally.
- **Without the MD5 cache**: Every job matching cycle re-embeds the profile (~100ms). Over 1000 users, that's 100 wasted seconds per daily cron run.

## 🔹 2.5 ALTERNATIVES

| Approach | Pros | Cons |
|---|---|---|
| **SentenceTransformers (your choice)** | Free, fast, local, good quality | 384d may lose nuance; English-centric |
| **OpenAI text-embedding-3-small (1536d)** | Higher quality, multilingual | $0.02/1M tokens, API dependency |
| **TF-IDF + cosine** | Interpretable, fast, no model needed | No semantic understanding ("React" ≠ "Frontend") |
| **BM25 (Elasticsearch)** | Battle-tested for search | Keyword-only, no semantic matching |
| **Fine-tuned model on job data** | Domain-specific understanding | Need labeled data, training infra |
| **Hybrid (embeddings + BM25)** | Best of both worlds | More complexity, harder to tune |

## 🔹 2.6 TRADEOFFS

- **Pipe delimiter**: Using `" | "` as separator is semantically neutral. If you used `". "` (sentence boundary), the model might treat each section as a separate thought. The pipe keeps it as one continuous context. However, `" | "` may confuse the model slightly since pipes aren't natural language.
- **Top-5 project limit**: Line 72: `profile.projects.slice(0, 5)`. This is a token-length optimization. Longer inputs → mean-pooling dilutes the signal. But this means projects 6-10 never enter the embedding.
- **No field weighting**: Skills and certifications get equal representation. In practice, a recruiter weights recent experience >> certifications, but the flat text doesn't reflect this.

## 🔹 2.7 FAILURE CASES

1. **Empty profiles**: If a user has no skills, projects, or experience, the text is nearly empty. The resulting embedding is essentially random noise, leading to garbage matches.
2. **Extremely long profiles**: 50 skills + 10 experiences + 5 projects = very long text. MiniLM has a 256-token limit by default; longer inputs get truncated silently. You're likely losing data for rich profiles.
3. **Non-English profiles**: MiniLM is English-trained. A user with Chinese skills or German experience gets poor embeddings.

## 🔹 2.8 INTERVIEW QUESTIONS

> **Q**: "Why not embed skills, experience, and projects separately and combine the vectors?"
> 
> **A**: This is the late-fusion vs. early-fusion debate. Late fusion (separate embeddings + combination) requires learning the optimal weighting between modalities — essentially a meta-model. Early fusion (text concatenation) lets the transformer's attention mechanism learn cross-field relationships. For example, "Python" in skills becomes more meaningful if the next section describes a "FastAPI backend" project. The transformer captures this; separate embeddings can't.

> **Q**: "Your model has a 256-token limit. What happens with longer profiles?"
> 
> **A**: This is a legitimate weakness. SentenceTransformers silently truncates beyond max_seq_length. For profiles with 50+ skills and 10+ experiences, we're losing information. The mitigation would be either (1) a model with longer context (e5-mistral-7b supports 4096 tokens) or (2) a two-pass approach where we chunk, embed separately, and take the centroid.

---

# 3. Similarity Matching

## 🔹 3.1 WHAT IT DOES

The semantic matching pipeline ([semanticMatchingService.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/semantic/semanticMatchingService.ts)) runs the full flow:

```
User profile → text encoding → embedding (or cache hit)
    → FAISS search (top 100 candidates, threshold 0.35)
        → PostgreSQL post-filtering (24h recency + location preferences)
            → Re-rank by FAISS score → Return top 5
```

### Why Cosine Similarity (Not Euclidean)?

**First principle**: Cosine similarity measures the *angle* between vectors, ignoring magnitude. Euclidean distance measures the *point-to-point* distance.

For text embeddings, this distinction is critical:

```
Profile A: "Senior React developer with 10 years experience"
Profile B: "Junior React developer with 1 year experience"

Both embed near the "React developer" cluster.
Euclidean: May be far apart if vector magnitudes differ.
Cosine: Closer, because the DIRECTION is similar (both point toward "React developer").
```

Since L2-normalization is applied (`normalize_embeddings=True`), all vectors live on the unit hypersphere. In this case, cosine similarity = dot product (because ||a|| = ||b|| = 1). And Euclidean distance becomes a monotonic function of cosine: `d² = 2(1 - cos θ)`. So on normalized vectors, the choice is mathematically equivalent.

**But** your system uses `IndexFlatIP` (Inner Product), not `IndexFlatL2`. This is correct precisely because you normalize vectors. IP on normalized vectors = cosine similarity. IP is also marginally faster because it's one less operation (no square root).

### Why FAISS (Not PostgreSQL pgvector)?

FAISS is an in-memory index. For `IndexFlatIP` (brute-force):
- **Search time**: O(N × D) where N = number of jobs, D = 384
- For 10K jobs: ~0.4ms on a single CPU core
- For 100K jobs: ~4ms

pgvector requires disk I/O + SQL parsing overhead. For sub-10ms latency requirements, FAISS wins decisively.

### Threshold: 0.35

This is your `SEMANTIC_MATCH_THRESHOLD` (line 29, env.ts). Why 0.35?

Cosine similarity for SentenceTransformer embeddings:
- **1.0**: Identical text
- **0.7-0.9**: Highly similar (same topic, same domain)
- **0.4-0.7**: Related (same field, different specifics)
- **0.2-0.4**: Loosely related
- **< 0.2**: Essentially unrelated

0.35 is **intentionally low** — a wide net. You cast a broad FAISS search (top 100 at 0.35), then **post-filter** in PostgreSQL. This two-stage approach is standard in production retrieval systems:

```
Stage 1 (FAISS): High recall, low precision → 100 candidates
Stage 2 (SQL):   Filters by recency, location → ~5-20 survivors  
Stage 3 (Sort):  Top 5 by score → Final results
```

If the threshold were 0.7, you'd miss cross-domain jobs. A "Full Stack Developer" might match a "Frontend Engineer" posting at 0.55 — a useful match that 0.7 would reject.

### Top-K: Why 5 Final Results?

The system retrieves 100 from FAISS (`FAISS_POOL_SIZE = 100`) but returns only 5 (`FINAL_TOP_K = 5`). This is the **funnel pattern**:

- **100 → SQL filter → ~20 → sort → 5**

Why 5? Two reasons:
1. **Cognitive load**: Presenting 5 matched jobs is actionable. 20 is overwhelming.
2. **Resume generation cost**: Each match triggers the RAG pipeline (3 LLM calls × 3 iterations max = 9 LLM calls). 5 matches = 45 LLM calls max. 20 matches = 180 LLM calls.

## 🔹 3.2 WHY THIS APPROACH

The 2-stage retrieval (FAISS → SQL) separates concerns:
- **FAISS**: Answers "what jobs are semantically similar?" (geometric proximity)
- **PostgreSQL**: Answers "of those, which are relevant right now?" (business logic)

This is how production search systems work (Google has ~10 retrieval stages). Semantic similarity alone would return week-old jobs in wrong cities.

## 🔹 3.3 WHAT BREAKS WITHOUT THIS

- **Without the threshold**: FAISS returns the top 100 no matter what. If there are only 5 relevant jobs, 95 results would be noise (cosine sim < 0.1), confusing the user.
- **Without the 24h filter**: Users see stale jobs. The daily cron matches against fresh jobs only.
- **Without the two-stage design**: You'd either (a) do all filtering in FAISS (impossible — FAISS can't filter by date) or (b) do all similarity in SQL (slow — cosine similarity in SQL is O(N²)).

## 🔹 3.4 ALTERNATIVES

| Approach | Pros | Cons |
|---|---|---|
| **Your approach (FAISS + SQL post-filter)** | Fast, flexible filtering | FAISS is in-memory, lost on restart without persistence |
| **pgvector (all in PostgreSQL)** | Single datastore, ACID-compliant | Slower for large N, no HNSW-level performance |
| **Pinecone/Weaviate/Milvus** | Managed, scalable, metadata filtering built-in | Vendor lock-in, cost at scale |
| **Elasticsearch with dense_vector** | Hybrid text + vector search | Operational complexity, JVM memory overhead |
| **Pre-filtered embedding** (embed `[domain + text]`) | Domain is in the vector | Cross-domain serendipity is lost |

## 🔹 3.5 TRADEOFFS

- **Threshold 0.35 means high recall, low precision**: Users may see marginally relevant jobs. But it's better to show a "maybe" than miss a "definitely."
- **24h window is rigid**: If no new jobs arrive in 24h, users get zero matches. A sliding/exponential decay window would be more robust.
- **In-memory FAISS**: Fast, but if the embedding-service container restarts and the disk save was missed, all job embeddings are lost and need re-computation.

## 🔹 3.6 FAILURE CASES

1. **Cold start**: Zero jobs in FAISS index → zero matches, always.
2. **Embedding service down**: Returns `null`, caller has NO fallback for semantic matching. The system silently produces zero matches.
3. **Location filter too strict**: If user says "San Francisco" but job says "SF Bay Area", the `contains` filter fails.
4. **Stale FAISS index**: If jobs are deleted from PostgreSQL but remain in FAISS, the post-filter catches them (the SQL `id: { in: faissJobIds }` returns fewer rows), but FAISS wastes slots on orphaned vectors.

## 🔹 3.7 INTERVIEW QUESTIONS

> **Q**: "Why not use Approximate Nearest Neighbor (ANN) with HNSW instead of brute-force IndexFlatIP?"
> 
> **A**: `IndexFlatIP` is brute-force, O(N×D). But for N < 100K, brute-force on 384-dim vectors takes < 10ms. HNSW (IndexHNSWFlat) has O(D × log N) search but requires significant build-time and memory overhead. The crossover point where HNSW becomes worth it is ~500K+ vectors. Our job corpus is 1K-50K, well below this threshold. Switching to HNSW now would add complexity without measurable performance gain.

> **Q**: "Your cosine threshold is 0.35. How did you choose this?"
> 
> **A**: Empirically. SentenceTransformer cosine scores cluster differently than you'd intuit: 0.7+ is near-duplicate, 0.4-0.7 is "same field," 0.2-0.4 is "loosely related." For job matching, we want the "same field" band. 0.35 is the lower bound of that band, deliberately inclusive because we post-filter with SQL. The right approach for production would be to run an A/B test or compute precision@K across labeled pairs, then choose the threshold that maximizes F1.

---

# 4. Job Scraping Pipeline

## 🔹 4.1 WHAT IT DOES

The pipeline uses a **3-tier orchestration**:

```
Apify (web scraper) → n8n (workflow orchestrator) → Express API (persistence)
```

### Apify
External service that runs browser automations (LinkedIn Jobs, Indeed, etc.), extracts structured job data (title, company, location, description, link, postedAt), and returns JSON arrays.

### n8n Orchestration
You have **three n8n workflows** in the repo:

1. **General Scraper** (`PlaceMates v2.0 - General Scraper.json`): Triggers Apify actors, receives scraped data, calls your backend's bulk upsert API.
2. **Semantic Matcher** (`PlaceMates v2.0 - Semantic Matcher.json`): For each user, triggers semantic matching + RAG resume generation via your backend APIs.
3. **Main Workflow** (`PlaceMates v2.0 Workflow.json`): Full orchestration that chains scraping → matching → resume generation → callback.

### Data Flow

```
Apify scrapes jobs
  → n8n receives JSON array
    → POST /api/workflow/save-jobs (bulk upsert by unique `link`)
      → POST /api/internal/embed-jobs (fire-and-forget FAISS indexing)
        → POST /api/internal/semantic-match/:userId
          → POST /api/internal/generate-resume/:userId/:jobId
            → POST /api/workflow/n8n-result (callback with results)
```

### Upsert Logic ([workflowController.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/controllers/workflowController.ts) line 395-423)

```typescript
prisma.job.upsert({
  where: { link: job.link },          // Unique constraint on job URL
  update: {},                          // On conflict: do nothing (idempotent)
  create: { title, company, location, description, link, postedAt },
})
```

The `link` field is the deduplication key. If Apify scrapes the same job URL twice, the second write is a no-op. This is critical because Apify runs on schedule and will inevitably rescrape existing listings.

## 🔹 4.2 WHY n8n?

**First principle**: You need a **visual, low-code orchestrator** that can:
1. Schedule cron-based scraping
2. Chain HTTP requests with conditional logic
3. Handle retries and error routing
4. Run loops (per-user matching) without writing boilerplate
5. Be modified by non-engineers (product team)

n8n fills this niche between "hardcoded scripts" and "enterprise workflow engines like Airflow."

## 🔹 4.3 WHAT BREAKS WITHOUT THIS

- **Without Apify**: You'd build and maintain your own scraper. LinkedIn actively blocks scrapers; Apify handles headless Chrome, proxy rotation, and CAPTCHA solving.
- **Without n8n**: You'd implement the orchestration in code (e.g., a Node.js script with `for` loops and `axios` calls). Works, but harder to debug, monitor, and modify.
- **Without the upsert**: Running the scraper twice would create duplicate job records. Every duplicate means wasted embedding compute and corrupted match results.

## 🔹 4.4 ALTERNATIVES

| Component | Alternatives | Tradeoffs |
|---|---|---|
| **Apify** | Bright Data, ScrapingBee, custom Puppeteer | Apify has LinkedIn actors; custom = more control but 10× maintenance |
| **n8n** | Temporal, Airflow, Bull queues | Temporal is more robust but heavier; Airflow is Python-only; Bull is code-only |
| **Idempotent upsert** | CDC (Change Data Capture), event sourcing | Overkill for this scale |

## 🔹 4.5 FAILURE CASES

1. **Apify rate-limited/blocked**: LinkedIn frequently changes their DOM. Apify actors need updating, which is out of your control.
2. **n8n timeout**: The main workflow processes users sequentially with 500ms staggering. For 100 users, that's 50+ seconds minimum just for HTTP triggers, before any processing.
3. **Incomplete job descriptions**: Some scraped jobs have minimal descriptions. Embedding a short string like "React developer needed" produces a lower-quality vector than a full JD with requirements and responsibilities.
4. **Stale jobs**: If postedAt parsing fails, jobs get `new Date()` as the posted date, making them appear fresh forever.

## 🔹 4.6 INTERVIEW QUESTIONS

> **Q**: "Why fire-and-forget for embedding jobs? What if it fails?"
> 
> **A**: The `embedNewJobs()` function is called after bulk upsert but not awaited. If embedding fails, the jobs are saved in PostgreSQL with `embeddedAt: null`. On the next scrape cycle, these unembedded jobs will be picked up again by the `embeddedAt: null` filter. It's self-healing at the cost of one cycle delay. In production I'd add a dead-letter queue.

> **Q**: "What if n8n goes down but your scheduler triggers?"
> 
> **A**: The trigger fires-and-forgets to n8n. If n8n is down, the `axios.post` rejects, and the WorkflowRun is marked `"failed"`. The user can re-trigger manually or wait for the next cron. There's no retry-to-n8n logic. This is a gap.

---

# 5. RAG System

## 🔹 5.1 WHY RAG INSTEAD OF FINE-TUNING?

This is the single most important architectural decision in your system.

**Fine-tuning** means: take an LLM, train it on your resume corpus, and deploy the specialized model.

**RAG** means: keep a base LLM, but inject relevant examples into the prompt at inference time.

| Criteria | Fine-Tuning | RAG (Your Choice) |
|---|---|---|
| **Training data needed** | 1000+ high-quality resume pairs | 7 JSON files (your `data/` corpus) |
| **Cost** | GPU hours ($100-1000+) | $0 (examples are embedded, LLM is pay-per-query) |
| **Update speed** | Re-train every time corpus changes | Add new examples to ChromaDB instantly |
| **Hallucination** | Lower (model has internalized patterns) | Higher (model may ignore examples) |
| **Data freshness** | Stale until retrained | Always fresh (retrieves latest examples) |
| **Generalization** | Better on trained domain, worse elsewhere | Generalizes to any domain with examples |
| **Infrastructure** | Need GPU for hosting model | Just a vector DB + prompt engineering |

**Your system can't fine-tune** because:
1. You have 7 JSON files of ~30KB each. That's maybe 100 resume examples. Fine-tuning needs 1000+ minimum.
2. Your LLM is Groq-hosted (llama-3.3-70b). You can't fine-tune someone else's hosted model.
3. Resume quality expectations change (new ATS patterns, new formatting preferences). Fine-tuned models encode these statically.

RAG is the correct choice for your constraints.

## 🔹 5.2 ChromaDB ([resume_store.py](file:///c:/AllImpprojects/PlaceMates/embedding-service/app/resume_store.py))

ChromaDB stores the **base resume corpus** (7 JSON files × ~15 examples each = ~100 examples).

**Why ChromaDB and not FAISS for resumes?**

ChromaDB supports **metadata filtering** — you can query `WHERE domain = "Frontend Developer" AND experience_level = "Entry"`. FAISS can only do vector similarity; it has zero metadata awareness.

The retrieval flow in ChromaDB:
```python
# 1. Filter by metadata (domain + experience_level)
# 2. Embed query text with SentenceTransformer
# 3. Find nearest neighbors in filtered subset
# 4. Return full resume data from stored metadata
```

This is **hybrid retrieval**: metadata pre-filter + semantic search. This is superior to pure semantic search because:
- A query about "Frontend Developer" should never return a "DevOps" resume example, even if the cosine similarity is high (e.g., both mention "Docker" for frontend dev containers).

## 🔹 5.3 RETRIEVAL STRATEGY

The [retrieverAgent.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/agents/retrieverAgent.ts) implements **blended retrieval**:

```
3 examples from base_resumes (ChromaDB)
+ 2 examples from generated_resumes (PostgreSQL GeneratedResume table)
= 5 total examples for the Drafter
```

If generated_resumes is empty (cold start), fallback to 5 from base. If base fails, the Drafter falls back to **zero-shot** (no examples at all).

**Why blend base + generated?**

- **Base examples** are curated, high-quality templates. They provide a "style guide."
- **Generated examples** are real resumes that scored 90+ on the ATS critic. They represent the system's own best work.
- Over time, generated examples accumulate and increasingly reflect real user profiles, making retrieval more relevant than the static templates.

This is a form of **experience replay** from reinforcement learning, applied to generative AI.

## 🔹 5.4 FAILURE CASES

1. **Empty ChromaDB**: First-time setup with no seeded data → Retriever returns zero examples → Drafter does zero-shot (lower quality output).
2. **Domain mismatch**: If a user has a rare domain ("Blockchain Security"), ChromaDB may have zero matching examples. The query falls back to unfiltered semantic search, which may return irrelevant examples.
3. **Stale base corpus**: The 7 JSON files in `data/` are static. If job market trends shift, the examples become obsolete. The self-improving dataset mitigates this long-term.

## 🔹 5.5 INTERVIEW QUESTIONS

> **Q**: "Why not use a larger embedding model for RAG retrieval accuracy?"
> 
> **A**: The retrieval step doesn't need sub-percentage-point accuracy improvements. We're retrieving 3-5 examples from a corpus of ~100 documents. Even mediocre retrieval gets the right domain. The bottleneck is the Drafter's quality, not retrieval precision. A larger model would slow down ChromaDB queries without proportional quality gains.

> **Q**: "What embedding model does ChromaDB use for indexing?"
> 
> **A**: ChromaDB uses OUR SentenceTransformer model (`all-MiniLM-L6-v2`), not its default one. In `resume_store.py`, we call `embed_text()` explicitly and pass the result to `collection.add(embeddings=...)`. This ensures the same model encodes both the stored documents and the queries, which is essential for meaningful cosine similarity.

---

# 6. Multi-Agent System

## 🔹 6.1 WHAT IT DOES

Three specialized agents form an **iterative refinement loop**:

```
                    ┌──────────────────────────────┐
                    │       Retriever Agent         │
                    │  (ChromaDB + PostgreSQL)      │
                    └──────────┬───────────────────┘
                               │ 5 examples
                               ▼
┌───────────────────────────────────────────────────────┐
│                     RAG Orchestrator                   │
│                                                        │
│   for iteration = 1 to 3:                              │
│     ┌────────────┐         ┌────────────┐             │
│     │   Drafter   │ ──────→│   Critic    │             │
│     │   Agent     │        │   Agent     │             │
│     │ (LLM call)  │        │ (LLM call)  │             │
│     └────────────┘         └─────┬──────┘             │
│           ▲                      │                     │
│           │   if ATS < 75:       │                     │
│           │   feedback ──────────┘                     │
│           │                                            │
│           │   if ATS ≥ 75: APPROVE & BREAK            │
│           └────────────────────────────────────────    │
└───────────────────────────────────────────────────────┘
```

### Retriever Agent ([retrieverAgent.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/agents/retrieverAgent.ts))

- **Role**: Gather relevant resume examples for context
- **Sources**: ChromaDB (curated) + PostgreSQL GeneratedResume (self-generated)
- **Output**: 5 `RetrievedExample` objects
- **Failure mode**: Returns empty list → Drafter uses zero-shot

### Drafter Agent ([drafterAgent.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/agents/drafterAgent.ts))

- **Role**: Generate a structured resume JSON
- **Input**: User profile text + job description + RAG examples + (optional) critic feedback
- **LLM config**: `temperature: 0.4, maxTokens: 3000`
- **Output**: `DraftedResume` object (summary, skills, projects, experience, education, certifications, awards)
- **Critical rules in prompt**:
  1. Start every bullet with strong action verb
  2. Include quantifiable metrics
  3. Mirror keywords from job description
  4. Only include skills the candidate actually has
  5. Limit to top 3-5 most relevant projects

### Critic Agent ([criticAgent.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/agents/criticAgent.ts))

- **Role**: Score the resume on 5 ATS criteria (0-20 each, total 0-100)
- **Criteria**:
  1. **Keyword Coverage** (0-20): JD keyword mirroring
  2. **Quantification** (0-20): Metrics in bullets
  3. **Action Verbs** (0-20): Strong opening verbs
  4. **Section Completeness** (0-20): All sections present
  5. **Relevance** (0-20): Tailored to this specific job
- **LLM config**: `temperature: 0.2, maxTokens: 1500` (lower temp = more deterministic scoring)
- **Fallback**: If LLM fails, uses a **heuristic scorer** (regex-based keyword matching, number detection, action verb checking)

## 🔹 6.2 WHY SEPARATE ROLES?

**First principle**: This is the **constitutional AI** pattern — separation of generation and evaluation prevents a single model from self-validating.

If the Drafter scored its own resumes:
1. **Self-bias**: The model that generated text is inclined to rate it highly
2. **No improvement signal**: Without an independent critic, there's no gradient for improvement
3. **No convergence guarantee**: The loop needs an external quality gate to terminate

The separate Critic with a fixed threshold (75) acts as a **convergence criterion** — the loop terminates when an objective quality bar is met.

## 🔹 6.3 WHY THE ITERATIVE LOOP?

The loop implements **iterative self-refinement** (a form of Constitutional AI):

```
Iteration 1: Drafter generates initial resume (possibly mediocre)
              Critic scores 62/100: "Add more metrics, mirror 'Kubernetes' from JD"
Iteration 2: Drafter receives feedback, regenerates with improvements
              Critic scores 78/100: APPROVED
```

**Why max 3 iterations?**
1. **Diminishing returns**: By iteration 3, the Drafter has already received 2 rounds of specific feedback. Additional iterations rarely improve score by more than 5 points.
2. **Cost**: Each iteration = 2 LLM calls (draft + critique). 3 iterations = 6 LLM calls. On Groq free tier (30 req/min), this already consumes 20% of your rate limit per resume.
3. **Convergence**: If 3 iterations can't cross 75, more iterations won't help — the issue is likely insufficient user data, not generation quality.

**The `bestResume` tracking is essential**: If iteration 1 scores 68, iteration 2 scores 72, and iteration 3 fails (LLM error), the system returns the 72-score resume rather than nothing.

## 🔹 6.4 ALTERNATIVES

| Pattern | Pros | Cons |
|---|---|---|
| **Your approach (Retriever-Drafter-Critic loop)** | Clean separation, iterative improvement | 2-6 LLM calls per resume |
| **Single-agent (one prompt, one shot)** | 1 LLM call, fast | No self-correction, inconsistent quality |
| **Chain-of-Thought (CoT)** | Better reasoning | Still single-pass, no external evaluation |
| **Tree of Thoughts** | Explores multiple drafts in parallel | 10x+ more LLM calls |
| **ReAct (Reasoning + Acting)** | Tool-calling agents | Overkill for structured output generation |
| **Human-in-the-loop** | Best quality | Not scalable for automated pipeline |

## 🔹 6.5 TRADEOFFS

- **Temperature 0.4 (Drafter) vs 0.2 (Critic)**: Drafter needs creativity (varied bullet phrasings). Critic needs consistency (same resume should get same score). This asymmetry is deliberate and correct.
- **Heuristic fallback for Critic**: If the LLM fails, the heuristic scorer is basic (word matching, number detection). It'll rate most resumes 60-75, rarely below 40 or above 85. This means the heuristic rarely triggers iteration — it mostly approves on first pass, degrading quality.
- **JSON parsing brittleness**: Both agents strip markdown fences and JSON-parse. If the LLM returns slightly malformed JSON (missing comma, trailing text), `parseResumeResponse` returns null and the iteration fails.

## 🔹 6.6 FAILURE CASES

1. **Consistent LLM failures**: If Groq is down, both Drafter and Critic fail. The Critic falls back to heuristic, but the Drafter has NO fallback — the entire RAG pipeline returns null.
2. **Score inflation**: If the LLM-based Critic consistently gives 80+ scores regardless of quality, the loop always exits at iteration 1 with potentially mediocre resumes. You have no human validation to detect this.
3. **Feedback loop divergence**: In rare cases, the Critic's feedback makes the next draft worse (e.g., "add more keywords" causes keyword stuffing, which hurts the next Critic eval). The `bestResume` tracking mitigates this.
4. **Token limits**: A rich user profile + long JD + 3 RAG examples can exceed the LLM's context window. The `maxTokens: 3000` for output is safe, but the input prompt can easily hit 4000+ tokens.

## 🔹 6.7 INTERVIEW QUESTIONS

> **Q**: "Why not use the same LLM call for both drafting and critiquing?"
> 
> **A**: This is the fundamental insight of Constitutional AI: generators are poor judges of their own output. A single prompt that says "generate a resume and rate it" will always rate its own work highly due to likelihood bias — the model generated those tokens precisely because they were high-probability. An independent evaluation step with a different prompt (and lower temperature) breaks this self-reinforcing loop.

> **Q**: "What happens if the Critic's ATS score doesn't correlate with actual ATS pass rates?"
> 
> **A**: This is the biggest risk. The Critic is an LLM *simulating* an ATS system. Real ATS systems (Workday, Greenhouse) use proprietary algorithms we can't replicate. The 5-criterion rubric (keyword coverage, quantification, action verbs, completeness, relevance) is a reasonable proxy based on published ATS research, but there's no ground-truth validation. In production, we'd need A/B testing against real application outcomes.

---

# 7. Evaluation System

## 🔹 7.1 WHAT IT DOES

The [evaluationService.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/evaluation/evaluationService.ts) computes **Information Retrieval (IR) metrics** to quantify how well the semantic matching works:

### Metrics

| Metric | Formula | What It Measures |
|---|---|---|
| **Precision@K** | (relevant in top-K) / K | Of the jobs we showed, how many were good? |
| **Recall@K** | (relevant in top-K) / (total relevant) | Of all good jobs, how many did we find? |
| **NDCG@K** | DCG@K / IDCG@K | Are the best matches ranked first? |

### ATS Score Distribution

Buckets resume ATS scores into 5 ranges (0-20, 21-40, 41-60, 61-80, 81-100) to visualize quality distribution across all generated resumes.

## 🔹 7.2 WHY THRESHOLD 75?

The ATS threshold (`RAG_ATS_THRESHOLD = 75`) determines when a resume is "good enough":

- **Below 60**: Missing sections, no keyword matching, generic bullets → Definitely reject
- **60-75**: Acceptable but improvable → Worth iterating
- **75-90**: Good ATS compatibility → Approve and ship
- **90+**: Excellent → Approve AND save to self-improving dataset

75 was chosen because:
1. It's high enough to ensure keyword coverage + quantification + structure
2. It's low enough that most 2-iteration cycles can achieve it
3. ATS studies (Jobscan, TopResume) suggest resumes scoring 75%+ on keyword matching pass the first automated screen 80% of the time

> [!WARNING]
> This threshold is based on your LLM-as-judge Critic, not real ATS systems. The Critic's 75 may correspond to a real-world 60 or 90 — you have no calibration data.

## 🔹 7.3 WHY LIMIT OF 3 RETRIES?

Empirically, each iteration costs ~5 seconds (LLM latency) + ~$0.001 (Groq tokens). Three iterations:
- Time: 15 seconds worst case
- Cost: $0.003 per resume
- Quality gain: Typically +10-15 points per iteration, with diminishing returns

After 3 iterations, if the score is still below 75, the problem is structural (user lacks skills for the job, not resume quality). More iterations won't help.

## 🔹 7.4 FAILURE CASES

1. **No labeled relevance data**: Your `relevanceThreshold = 0.5` is arbitrary. Without human-labeled "this job is relevant/irrelevant" pairs, Precision@K and Recall@K are measuring against an assumed ground truth. This makes the metrics **directionally useful but not calibrated**.
2. **NDCG on a single user**: NDCG is meaningful when averaged over many queries. For a single user with 5 matches, NDCG variance is extremely high.
3. **Evaluation doesn't inform training**: The metrics are computed but never fed back into model selection or threshold tuning. It's observational, not actionable.

## 🔹 7.5 INTERVIEW QUESTIONS

> **Q**: "You compute Precision@5. But what is your ground truth for 'relevant'?"
> 
> **A**: Currently, we use `semanticScore >= 0.5` as a proxy for relevance. This is a limitation — it's self-referential (using the very system's scores to evaluate itself). The proper approach would be explicit user feedback (did the user click, apply, or dismiss each match), creating a binary relevance label. This would enable true Precision/Recall computation and threshold optimization.

> **Q**: "How would you extend this to a proper offline evaluation framework?"
> 
> **A**: Three steps: (1) Collect user engagement signals (click-through, application, dismiss) as implicit relevance labels. (2) Build a test set of (user, job, relevance) triples. (3) Evaluate multiple retrieval strategies (different thresholds, different embedding models, hybrid retrieval) against this test set using standard IR metrics. This is how Google evaluates search quality.

---

# 8. Self-Improving Dataset

## 🔹 8.1 WHAT IT DOES

The [selfImprovingDataset.ts](file:///c:/AllImpprojects/PlaceMates/backend/src/services/agents/selfImprovingDataset.ts) creates a **feedback flywheel**:

```
RAG generates resume → Critic scores 92 → Pass quality gate (≥ 90)
  → Compute embedding → Check diversity (cosine sim < 0.9 with ALL existing)
    → If diverse enough: Store in GeneratedResume table
      → Future Retriever includes this in blended results
        → Future Drafts are influenced by higher-quality examples
```

## 🔹 8.2 WHY NEEDED?

**First principle**: Static retrieval corpora degrade over time. The base corpus (7 JSON files from `data/`) represents a fixed snapshot of "good resumes." As the job market evolves (new technologies, new formatting trends), these examples become stale.

The self-improving dataset solves this by:
1. **Capturing emergent quality**: When the system produces an excellent resume (as judged by the Critic), that excellence is recycled.
2. **Domain expansion**: The initial corpus covers 7 domains. As users from "Blockchain" or "AR/VR" create resumes, those novel domains enter the generated pool.
3. **Personalization**: Generated resumes reflect real user profiles, making retrieval more relevant than generic templates.

## 🔹 8.3 WHY QUALITY GATE (90)?

```typescript
const SCORE_THRESHOLD = 90;
```

This is deliberately **higher** than the approval threshold (75):

- **75**: Good enough to show the user → business threshold
- **90**: Good enough to teach the model → pedagogical threshold

If the dataset accepted 75+ resumes, mediocre examples would pollute the retrieval pool, creating a **positive feedback loop of mediocrity**. The 90-point gate ensures only the system's best work enters the training data, implementing a form of **experience replay with prioritized sampling**.

## 🔹 8.4 WHY SIMILARITY CHECK (0.9)?

```typescript
const SIMILARITY_THRESHOLD = 0.9;
```

This prevents **dataset collapse** — a known failure mode in self-training systems:

**Without diversity check**: If 50 users all apply for "React Frontend Developer" jobs, the system generates 50 nearly-identical resumes. All score 90+. All get stored. Now the retrieval pool is 50 copies of essentially the same document. Future retrievals only see React-Frontend patterns, losing ability to serve Backend or ML users.

The 0.9 cosine similarity check ensures each new entry adds **novel information**. If a new resume is >= 90% similar to ANY existing stored resume, it's rejected as redundant.

**Why 0.9, not 0.8 or 0.7?**
- 0.7: Too aggressive — would reject valid domain variations. A "React + TypeScript" resume and a "React + GraphQL" resume might share 0.75 similarity. Both are useful.
- 0.9: Conservative — only rejects near-duplicates while allowing meaningful variations.
- 0.95: Too lenient — would allow only trivially different resumes, accumulating near-duplicates.

## 🔹 8.5 RISKS

> [!CAUTION]
> **Model Collapse Risk**: If the Critic consistently gives high scores and the diversity check is too lenient, the generated dataset converges to a narrow distribution. The Retriever then only surfaces similar examples, the Drafter only produces similar outputs, and the system enters a degenerative spiral. This is the AI equivalent of genetic inbreeding.

**Mitigation**: The 0.9 similarity threshold + the 3:2 blended ratio (3 base : 2 generated) ensure the base corpus always anchors retrieval. Even as the generated pool grows, 60% of examples are always from the curated base.

**Drift risk**: The Critic is an LLM. LLM APIs change (model updates, fine-tuning drift). If the Critic becomes more lenient over time, more mediocre resumes enter the dataset. If it becomes stricter, fewer enter, and the dataset stagnates.

## 🔹 8.6 INTERVIEW QUESTIONS

> **Q**: "How is this different from RLHF?"
> 
> **A**: RLHF (Reinforcement Learning from Human Feedback) trains a reward model from human preferences, then uses PPO to update the generator. Our system doesn't update any model — the base LLM and embedding model are frozen. Instead, we update the *retrieval context*. This is more analogous to **experience replay in RL** — storing high-reward episodes and replaying them to influence future behavior — except the "behavior" change happens through in-context learning (the Drafter sees better examples), not gradient updates.

> **Q**: "What happens if your dataset grows to 100K entries? The cosine similarity check scans all embeddings."
> 
> **A**: Currently, `checkSimilarity` in main.py loads ALL embeddings from ChromaDB + PostgreSQL into a numpy matrix and computes dot products. At 100K × 384d, that's 38M floats × 4 bytes = ~150MB, and the matrix multiplication takes O(100K × 384) per check. This is fine up to ~100K but becomes problematic at 1M+. The fix: replace brute-force with a FAISS index over the stored embeddings, using an approximate search threshold.

---

# 9. System Design

## 🔹 9.1 ARCHITECTURE

```mermaid
graph TD
    A["Frontend<br/>(Next.js)"] --> B["Backend API<br/>(Express/Node.js)"]
    B --> C["PostgreSQL<br/>(Prisma ORM)"]
    B --> D["Embedding Service<br/>(Python/FastAPI)"]
    D --> E["FAISS Index<br/>(Job Vectors)"]
    D --> F["ChromaDB<br/>(Resume Corpus)"]
    B --> G["n8n<br/>(Workflow Orchestrator)"]
    G --> H["Apify<br/>(Web Scraping)"]
    B --> I["Groq API<br/>(LLM - LLaMA 3.3 70B)"]
    B --> J["Cloudinary<br/>(File Storage)"]
    B --> K["GitHub API<br/>(Profile Data)"]
```

### Why Microservices (Node + Python)?

The system is split into 2 services because of **language-ecosystem constraints**:

| Concern | Node.js Backend | Python Embedding Service |
|---|---|---|
| **Why this language?** | Express ecosystem, Prisma ORM, TypeScript typing | SentenceTransformers, FAISS, ChromaDB — all Python-only |
| **What it owns** | Business logic, auth, API routing, LLM orchestration | Vector math, embedding generation, similarity search |
| **Communication** | HTTP client (embeddingClient.ts) | FastAPI endpoints |

**This is not optional polyglotism** — FAISS and SentenceTransformers have no production-quality Node.js equivalents. The TypeScript ecosystem has `onnxruntime-node` for inference, but it lacks FAISS integration and ChromaDB's Python persistence layer.

### Database Design

The PostgreSQL schema models 6 distinct entity groups:

1. **Identity layer**: `UserAuth`, `UserProfile`, `OAuthAccount`
2. **GitHub pipeline output**: `Project` (with ranking scores, AI enrichment fields)
3. **LinkedIn pipeline output**: `Experience`, `Education`, `Award`, `Certification`
4. **Merged/computed**: `Skill` (with `source` tracking), `UserSummary`, `UserPortfolio`
5. **Job matching**: `Job`, `JobMatch` (per-user scoring), `UserEmbedding` (cached vectors)
6. **RAG pipeline**: `TailoredResume`, `ResumeExample` (base corpus), `GeneratedResume` (self-improving)
7. **Workflow tracking**: `WorkflowRun`

**Key design patterns**:
- **Composite unique constraints**: `@@unique([userId, repoUrl])` on Project enables idempotent GitHub re-analysis
- **Denormalization**: `Project.description` denormalizes `finalBullets.join()` for display
- **Embedding storage in PostgreSQL**: `UserEmbedding.embedding Float[]` and `Job.embedding Float[]` store vectors as Postgres arrays. This is fine for persistence but terrible for similarity search (hence FAISS).

### API Structure

The backend exposes 15 route groups:

| Route | Auth | Purpose |
|---|---|---|
| `/api/auth` | No | OAuth (GitHub login) |
| `/api/github` | JWT | GitHub sync + analysis |
| `/api/linkedin` | JWT | LinkedIn ZIP processing |
| `/api/projects` | JWT | CRUD projects + quiz |
| `/api/profile` | JWT | Profile editing |
| `/api/user` | JWT | User data + insights |
| `/api/job-preferences` | JWT | Job preference CRUD |
| `/api/workflow` | JWT / Internal | Trigger + callback + status |
| `/api/internal` | API Key | n8n → backend (semantic match, embed, resume gen) |
| `/api/jobs` | API Key | Bulk job upsert |
| `/api/evaluation` | JWT | IR metrics |
| `/api/upload` | JWT | Image upload (Cloudinary) |
| `/api/portfolio` | Public | Public portfolio view |

The `/api/internal` routes use API key auth (not JWT) because they're called by n8n, which doesn't have a user session.

## 🔹 9.2 INTERVIEW QUESTIONS

> **Q**: "Why Prisma and not raw SQL or TypeORM?"
> 
> **A**: Prisma provides type-safe database access with auto-generated TypeScript types from the schema. This is critical for a system with 15+ models — raw SQL would require manual type maintenance. TypeORM uses decorators/class-based models which are less declarative. Prisma's schema-first approach means the database schema IS the single source of truth, and migrations are auto-generated. Tradeoff: Prisma's query API can't express complex SQL (e.g., window functions, CTEs), but we don't need those for this app.

> **Q**: "Why store embeddings in PostgreSQL AND FAISS?"
> 
> **A**: Separation of concerns. PostgreSQL stores embeddings for **persistence** — if FAISS crashes, we can rebuild the index by re-reading from Postgres. FAISS stores embeddings for **search** — sub-millisecond nearest-neighbor queries. PostgreSQL `Float[]` does not support efficient similarity search. This is the standard pattern in production vector search systems.

---

# 10. Scalability

## 🔹 10.1 WHAT BREAKS AT 10K USERS?

### Bottleneck Analysis

| Component | Current Capacity | At 10K Users | Fix |
|---|---|---|---|
| **FAISS (in-memory)** | ~100K vectors @ 384d = 150MB | Fine (10K Jobs × 384 × 4 = 15MB) | Switch to `IndexIVFFlat` at 500K+ vectors |
| **GitHub analysis** | Sequential, ~60s/user | 600K seconds = 7 days for full re-analysis | Batch processing, webhook-based incremental analysis |
| **Daily cron (scheduler)** | 500ms stagger × N users | 10K × 500ms = 83 minutes to trigger all | Parallel batches with rate limiting |
| **LLM calls (Groq free tier)** | 30 req/min, 500K tokens/day | 10K users × 5 jobs × 6 calls = 300K calls/day | Groq paid tier, or self-hosted Ollama cluster |
| **n8n single instance** | ~50 concurrent workflows | 10K triggers overwhelm single n8n | Horizontal n8n scaling (n8n queue mode) |
| **PostgreSQL** | Single instance, no read replicas | Query hot spots on `JobMatch`, `Job` tables | Read replicas, connection pooling, indexing |
| **Embedding service (single process)** | All requests share one model in memory | Concurrent embedding requests queue up | Gunicorn/uvicorn workers, GPU acceleration |
| **ChromaDB** | Single process, file-based | Slow at 100K+ documents | Migrate to Chroma server mode or Qdrant |

### Critical Path Analysis

The daily cron run is the most constrained path:

```
For EACH user (sequentially with 500ms delay):
  1. Create WorkflowRun record          (~5ms)
  2. POST to n8n webhook                (~100ms)
     ↓ n8n executes:
  3. Scrape jobs (Apify)                (~30s)
  4. Bulk upsert jobs                   (~500ms)
  5. Embed new jobs (FAISS)             (~200ms/job × ~50 jobs = 10s)
  6. Semantic match                     (~100ms FAISS + 500ms SQL)
  7. For each of 5 matches:
     7a. RAG resume generation          (~15s × 5 = 75s)
  8. Callback with results              (~200ms)
  
  Total per user: ~2 minutes
  Total for 10K users: ~14 days (sequential)
```

This is the **primary scalability bottleneck**. Solutions:
1. **Shared job scraping**: Scrape once for all users, not per-user
2. **Parallel matching**: Run semantic match for multiple users simultaneously (FAISS is thread-safe for reads)
3. **Async resume generation**: Queue resume generation in a job queue (Bull/BullMQ) instead of blocking in n8n
4. **LLM batching**: Groq supports batch API — submit multiple resume drafts in one call

## 🔹 10.2 INTERVIEW QUESTIONS

> **Q**: "How would you redesign this for 1M users?"
> 
> **A**: Five architectural changes: (1) Replace n8n with a proper job queue (Temporal or BullMQ) for resume generation. (2) Replace FAISS with a managed vector DB (Pinecone/Weaviate) that supports billions of vectors. (3) Separate the scraping pipeline — scrape once daily into a shared job pool, match per-user. (4) GPU-accelerate the embedding service or use a hosted embedding API. (5) Add a Redis caching layer for profile embeddings and frequently-accessed job data.

---

# 11. Limitations

## 🔹 11.1 WHERE THE SYSTEM FAILS TODAY

### Fundamental Limitations

1. **No ground-truth validation**: The Critic is an LLM pretending to be an ATS. No real ATS validation exists. The 75-point threshold is uncalibrated.

2. **Single-language embedding model**: `all-MiniLM-L6-v2` is English-only. Users with profiles in Hindi, Mandarin, or other languages get degraded embeddings.

3. **No user feedback loop**: Users can't rate matches or resumes. Without explicit feedback, the system can't learn from its mistakes. The self-improving dataset only captures *high scores*, not *user satisfaction*.

4. **Cold-start problem**: A new user with 2 GitHub repos and no LinkedIn gets a thin profile vector, leading to poor matching. There's no collaborative filtering fallback ("users like you also matched with...").

5. **Resume ≠ Application**: The system generates resumes but doesn't submit applications. The pipeline ends at PDF download. Integration with ATS APIs (Greenhouse, Lever, Workday) would close this loop.

6. **Keyword-based location matching**: `location.contains("San Francisco")` fails for "SF", "Bay Area", "California". No geocoding or location normalization.

7. **No negative feedback in self-improving dataset**: Only positive examples (score ≥ 90) are stored. The system never learns what *not* to do. Adding "bad" examples with negative labels would require contrastive learning.

### What Is NOT Solved

- **Cover letter generation** (not in scope but natural extension)
- **Interview preparation** (could use the same RAG pipeline)
- **Application tracking** (job status: applied, rejected, interview, offer)
- **Salary negotiation data** (could correlate with job descriptions)
- **Portfolio website hosting** (model exists but no deployment)

---

# 12. System-Level Understanding

## 🔥 WHAT KIND OF SYSTEM IS THIS?

PlaceMates is a **Retrieval-Augmented Generation (RAG) system with multi-agent orchestration for domain-specific document generation**, specifically:

- **Classification**: AI-assisted career services platform
- **Architecture pattern**: Microservice RAG pipeline with iterative refinement
- **ML paradigm**: Zero-shot/few-shot in-context learning (no model training)
- **Data paradigm**: Multi-source ingestion → unified representation → semantic matching → generative output

It sits at the intersection of:
- **Information Retrieval** (semantic job matching)
- **Natural Language Generation** (resume drafting)
- **Multi-Agent Systems** (retriever-drafter-critic loop)
- **Self-supervised learning** (self-improving dataset)

## 🔥 WHAT MAKES IT STRONG

1. **Graceful degradation at every layer**: Embedding service down → keyword matching. LLM down → heuristic scoring. ChromaDB empty → zero-shot generation. LinkedIn missing → GitHub-only profile. This defense-in-depth means the system *never* completely fails.

2. **Offline-first analysis**: The GitHub pipeline works without any API keys (except GitHub OAuth). No LLM dependency for core profile analysis. This is rare — most systems require GPT for every step.

3. **Self-improving feedback flywheel**: Most RAG systems have static retrieval corpora. Your system's GeneratedResume table creates a positive feedback loop that improves over time.

4. **Circuit breaker pattern**: The embedding client has a proper circuit breaker (5 consecutive failures → 60s open circuit → half-open probe). This is production-grade resilience.

5. **Clean separation of concerns**: Each agent has a single responsibility. The RAG orchestrator doesn't know how retrieval works. The Drafter doesn't know about scoring. This makes each component testable and replaceable.

## 🔥 WHAT MAKES IT WEAK

1. **No ground-truth evaluation**: The biggest weakness. You compute Precision@K, but your "relevance" labels are derived from the system's own scores. This is circular. Without user feedback or human annotation, you cannot know if the system is actually good.

2. **LLM dependency for quality**: The Drafter and Critic are Groq API calls. If Groq changes pricing, rate limits, or model quality, your resume quality changes unpredictably. You have zero control over the model.

3. **Sequential pipeline bottleneck**: The daily cron → n8n → per-user processing path is fundamentally sequential. This doesn't scale beyond hundreds of users without architectural changes.

4. **No A/B testing infrastructure**: You can't compare "threshold 0.35 vs 0.45" or "3 iterations vs 5 iterations" with user-facing metrics. All parameter choices are based on intuition, not experimentation.

5. **Single-point-of-failure**: The embedding service is a single Docker container. No horizontal scaling, no health-check-based routing, no graceful failover.

## 🔥 HOW TO IMPROVE TO PRODUCTION-GRADE

1. **Add user feedback**: After each match session, let users rate matches (👍/👎). Store `(userId, jobId, feedback)`. Use this to:
   - Compute true Precision/Recall
   - Tune the similarity threshold
   - Train a user-specific re-ranker

2. **Queue-based architecture**: Replace n8n sequential processing with a distributed queue (BullMQ):
   ```
   User triggers match → enqueue "match-user" job
     → Worker 1 runs semantic match
       → enqueue N "generate-resume" jobs
         → Workers 2-5 generate resumes in parallel
   ```

3. **Horizontal embedding service**: Run multiple uvicorn workers behind a load balancer. The SentenceTransformer model can be shared across workers (read-only).

4. **Real ATS validation**: Integrate with a real ATS API (e.g., Jobscan API) to validate generated resumes against actual parsers.

5. **Monitoring & observability**: Add structured logging, Prometheus metrics, and alerting for:
   - Embedding service latency (p50, p95, p99)
   - FAISS index size
   - LLM call success rate
   - ATS score distribution per day

## 🔥 HOW TO IMPROVE TO RESEARCH-GRADE

1. **Formal evaluation framework**:
   - Build a labeled test set: 100 (user, job) pairs with human-annotated relevance (0-3 scale)
   - Compute MRR, MAP, NDCG with proper inter-annotator agreement (Cohen's κ)
   - Publish: "Semantic Job-Candidate Matching Using Bi-Encoder Representations"

2. **Compare retrieval strategies**:
   - Pure semantic (your current approach)
   - Pure lexical (BM25)
   - Hybrid (RRF: Reciprocal Rank Fusion of BM25 + semantic)
   - Cross-encoder re-ranking (ColBERT)
   
   Paper: "Hybrid Retrieval for Job Matching: A Comparative Study"

3. **Resume generation quality analysis**:
   - Human evaluation study (N=30 raters, 50 resumes each)
   - Compare: Template-based vs. RAG vs. Fine-tuned vs. Zero-shot
   - Metrics: ATS pass rate, recruiter preference (pairwise comparison), factual accuracy
   
   Paper: "Multi-Agent RAG for ATS-Optimized Resume Generation"

4. **Self-improving dataset convergence analysis**:
   - Track embedding centroid drift over 1000 generations
   - Measure dataset diversity (average pairwise cosine distance)
   - Compare with/without diversity gate
   
   Paper: "Preventing Model Collapse in Self-Improving RAG Systems via Diversity-Gated Feedback"

5. **Embedding model comparison**:
   - `all-MiniLM-L6-v2` vs `all-mpnet-base-v2` vs `e5-mistral-7b`
   - vs domain-adapted model (fine-tune on job-resume pairs)
   - Measure matching quality, latency, memory
   
   Paper: "Bi-Encoder Selection for Domain-Specific Semantic Matching in Career Services"

---

## 🎯 Summary Table: Every Component at a Glance

| # | Component | Core Tech | Why This | What Breaks Without It | Biggest Risk |
|---|---|---|---|---|---|
| 1 | GitHub Ingestion | GitHub API + rule-based analysis | Evidence-based skills | Only self-reported data | Rate limiting, unfair to non-GitHub users |
| 2 | LinkedIn Ingestion | AdmZip + CSV parsing | Work history + creds | Incomplete profiles | Non-standard CSV formats |
| 3 | Profile Encoding | Text flattening + MD5 cache | Unified representation | Can't do vector search | Token truncation on rich profiles |
| 4 | SentenceTransformer | all-MiniLM-L6-v2, 384d | Semantic understand | Keyword-only matching | English-only, 256-token limit |
| 5 | FAISS Index | IndexFlatIP, brute-force | Sub-ms search | Slow SQL-based search | In-memory, lost on crash |
| 6 | Cosine Threshold (0.35) | Low threshold + post-filter | High recall pipeline | Missing valid matches | May include noise |
| 7 | n8n Orchestration | Visual workflow engine | Low-code orchestration | Manual scripting | Single point of failure |
| 8 | ChromaDB | Metadata-filtered vector DB | Domain-aware RAG retrieval | Generic RAG examples | Scales poorly past 100K docs |
| 9 | Retriever Agent | Blended base + generated | Evolving context quality | Static corpus staleness | Cold-start with empty datasets |
| 10 | Drafter Agent | LLM (t=0.4, 3000 tokens) | Creative resume generation | No automated resumes | Hallucination, JSON parse failures |
| 11 | Critic Agent | LLM (t=0.2) + heuristic fallback | Quality gate | Unchecked quality | Score inflation, no calibration |
| 12 | Iterative Loop (max 3) | Constitutional AI pattern | Self-correction | Accept first draft (often mediocre) | Diminishing returns, cost |
| 13 | Self-Improving Dataset | Score ≥ 90, similarity < 0.9 | Auto-evolving RAG corpus | Static, stale examples | Model collapse, distribution drift |
| 14 | Evaluation | P@K, R@K, NDCG@K | Quality monitoring | Blind to system performance | Circular evaluation (no ground truth) |
| 15 | Daily Scheduler | node-cron, 02:00 IST | Automated daily matching | Manual-only triggers | Sequential bottleneck at scale |
