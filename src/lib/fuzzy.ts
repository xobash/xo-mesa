/** Subsequence fuzzy score (higher = better, 0 = no match). */
export function fuzzy(q: string, text: string): number {
  if (!q) return 0.5;
  const t = text.toLowerCase();
  q = q.toLowerCase();
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += 1 + streak;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return 0;
  if (t.startsWith(q)) score += 6;
  return score / (1 + t.length * 0.04);
}
