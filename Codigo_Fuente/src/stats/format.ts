export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return "0";
  }
  if (n < 1000) {
    return String(Math.round(n));
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  }
  if (n < 1_000_000_000) {
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  }
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) {
    return "$0";
  }
  if (cost < 0.0001) {
    return "<$0.0001";
  }
  if (cost < 1) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

export function formatRelative(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return "—";
  }
  const diff = now - ts;
  if (diff < 0) {
    return "ahora";
  }
  const s = Math.floor(diff / 1000);
  if (s < 5) {
    return "ahora";
  }
  if (s < 60) {
    return `hace ${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `hace ${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `hace ${h}h`;
  }
  const d = Math.floor(h / 24);
  return `hace ${d}d`;
}
