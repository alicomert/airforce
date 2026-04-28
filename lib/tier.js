// api.airforce model tier sınıflandırması.
//   multiplier null/0/1   → free
//   multiplier 2..10      → premium
//   multiplier > 10       → p2g (Pay-As-You-Go)

export function classifyTier(multiplier) {
  const m = Number(multiplier);
  if (!Number.isFinite(m) || m <= 1) return 'free';
  if (m > 10) return 'p2g';
  return 'premium';
}

// Tier'a "ne kadar agresif probe edeceğiz?" eşiği koy.
//   tier === 'free'    → sadece free
//   tier === 'premium' → free + premium
//   tier === 'all'     → hepsi (p2g dahil)
export function tierAllowed(modelTier, allowedTier) {
  if (allowedTier === 'all') return true;
  const order = { free: 0, premium: 1, p2g: 2 };
  const a = order[modelTier] ?? 0;
  const b = order[allowedTier] ?? 0;
  return a <= b;
}

export function tierPriority(t) {
  return ({ free: 0, premium: 1, p2g: 2 })[t] ?? 9;
}
