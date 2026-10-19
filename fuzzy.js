// fzf-style subsequence matching: every pattern character must appear in the id in order,
// matches at word starts and runs of adjacent characters score higher, gaps cost a little.
const SEPARATORS = /[\s\-_/.]+/g;

function isBoundary(text, i) {
  if (i === 0) return true;
  const prev = text[i - 1];
  if ('/-_.'.includes(prev)) return true;
  const digit = (c) => c >= '0' && c <= '9';
  return digit(prev) !== digit(text[i]); // phi|3, 3|mini
}

function scoreFrom(text, pattern, start) {
  let score = 0;
  let last = -1;
  let ti = start;
  for (const ch of pattern) {
    while (ti < text.length && text[ti] !== ch) ti++;
    if (ti === text.length) return null;
    score += 16;
    if (isBoundary(text, ti)) score += 8;
    // A gap made only of separators still counts as adjacent: gemma-2 ~ gemma2.
    const gap = last >= 0 ? text.slice(last + 1, ti) : '';
    if (last >= 0 && /^[-_/.]*$/.test(gap)) score += 8;
    else if (last >= 0) score -= Math.min(gap.length, 8);
    last = ti++;
  }
  // Prefer matches in the model name over the owner part before '/'.
  if (start > text.indexOf('/')) score += 4;
  return score - Math.min(start, 10) / 2;
}

function fuzzyScore(id, query) {
  const pattern = query.toLowerCase().replace(SEPARATORS, '');
  if (!pattern) return 0;
  const text = id.toLowerCase();
  let best = null;
  for (let i = text.indexOf(pattern[0]); i !== -1; i = text.indexOf(pattern[0], i + 1)) {
    const s = scoreFrom(text, pattern, i);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

// Match quality first, popularity as the tie-breaker.
function rank(models, query, limit) {
  const scored = [];
  for (const m of models) {
    const s = fuzzyScore(m.id, query);
    if (s !== null) scored.push({ model: m, score: s + 6 * Math.log10((m.downloads ?? 0) + 1) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.model);
}

module.exports = { fuzzyScore, rank };
