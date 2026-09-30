# Registry refresh process

Every fact shown on the page comes from `data/registry.json`. Nothing is fetched while someone views the page. Treat the page as a dated snapshot. Each record and each category carries its own `asOf` date, and the page never claims a global "last updated" or "current" state.

This process is **human- and source-review-gated**. It is meant to run daily, but no automation publishes changes. A person checks every change against the official source and then merges it. There is no scheduled job, so the page must not claim that one exists.

## Daily review checklist

1. **Check the official sources** listed in `registry.sources` (pricing pages, model pages, changelogs, release pages, FX rate).
   - Prices: Anthropic, OpenAI and Google pricing pages, plus the model page for context and max-output limits.
   - Launches and access changes: provider changelogs and release notes.
   - FX: US Federal Reserve H.10 India series (rupees per US dollar). Record the rate **and** its rate date.
   - Protocols and repositories: the GitHub release pages (`gh api repos/<owner>/<repo>/releases`).
   - GPUs: the provider pricing page. Note the cloud tier if the page makes it ambiguous.
2. **Edit `data/registry.json` only.** Never hand-edit the inline copy in `index.html`.
   - Only primary sources count: vendor docs, official changelogs and official release pages. Blogs, aggregators, search-result snippets and leaderboards do not count as evidence for a factual record.
   - For each record you verified, update `asOf` and the source's `accessed` date. Update the category `asOf` only after reviewing every record in that category.
   - If you cannot verify a fact, **remove it** or move it into editorial guidance without numbers. Never carry an old number forward unverified.
   - Enter money in the provider's native USD fields (`inputUsdPerMTok`, `usdPerHour`). The page converts it to INR with `registry.fx`. Do not write ₹ amounts into text.
   - Record promotional or scheduled prices with `priceValidUntil` and `scheduledPrice`. The validator fails once the listed price has expired.
   - Editorial text (recommendations, picks, sections) is opinion. Keep it dated through the `editorial` category and avoid words like "latest", "current", "today", "right now" and "live". Write explicit dates instead.
3. **Bump `revision`** (`YYYY.MM.DD-rN`) whenever registry content changes.
4. **Build and validate:**
   ```sh
   node scripts/build.mjs              # inline registry into index.html, sync meta revision + sw.js cache name
   node scripts/validate-registry.mjs  # schema, sources, staleness, language, INR-only, drift checks
   node scripts/render-check.mjs       # headless Chrome render of mobile + desktop layouts
   ```
5. **Review the diff** (`git diff data/registry.json`). Confirm that every changed number matches its source. Then commit and push to `main`. Vercel's Git integration deploys production from `main`. `npm run build` (configured in `vercel.json`) runs the validator there, so a stale or invalid registry blocks the deploy.
6. **Verify production:** the live HTML must contain `<meta name="kawin-registry-revision" content="<revision>">`. The Vercel deployment must reference the pushed commit SHA.

## What the validator enforces

`scripts/validate-registry.mjs` exits non-zero when any of these fail:

- A factual record (`fx`, `models`, `gpus`, `launches`, `protocols`, `repos`) lacks an id, a primary-source category, an `asOf` date, or at least one resolvable https source.
- A record or category is older than `--max-age-days` (default 30), or a listed price is past `priceValidUntil`.
- The page text or registry text uses global freshness language, for example: current, latest, today, right now, live data, audited, last updated, cron, "this cycle".
- The page or registry shows non-INR money amounts or hardcoded rupee amounts (all ₹ values are computed).
- `index.html`'s inline registry, the revision meta tag or `sw.js` `CACHE_NAME` has drifted from `data/registry.json`.
- `content.txt` (the old orphaned copy) exists again.

Use `--today=YYYY-MM-DD` to simulate a future review date. For example, `--today=2027-01-02` shows which records and prices would be expired.
