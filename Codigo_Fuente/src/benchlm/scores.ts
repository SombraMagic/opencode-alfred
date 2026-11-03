/**
 * Las cuatro notas de BenchLM (`overall`, `coding`, `agentic` y `knowledge`) en la forma mínima
 * que pintan las tarjetas de Conectores y del tablero de asignación.
 *
 * Vive aparte de `panels/modelComparePanel.ts` porque lo usan otros paneles y este módulo no
 * puede importar `vscode`.
 */

export interface BenchlmScore {
  rank: number;
  score: number;
}

export interface BenchlmScores {
  overall?: BenchlmScore;
  coding?: BenchlmScore;
  agentic?: BenchlmScore;
  knowledge?: BenchlmScore;
}

/** Superficies que BenchLM publica aparte de `overall`, en el orden en que se pintan. */
const SURFACES = ["coding", "agentic", "knowledge"] as const;

function asScore(value: unknown): BenchlmScore | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const { rank, score } = value as Record<string, unknown>;
  if (typeof rank !== "number" || !Number.isFinite(rank)) {
    return undefined;
  }
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return undefined;
  }
  return { rank, score };
}

/**
 * Las cuatro superficies de una ficha de BenchLM; `undefined` si no hay ninguna.
 * Una superficie sin `rank` y `score` numéricos se omite.
 */
export function benchlmScores(
  data: { overall?: BenchlmScore; categories?: Record<string, BenchlmScore> } | undefined
): BenchlmScores | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const scores: BenchlmScores = {};
  const overall = asScore(data.overall);
  if (overall) {
    scores.overall = overall;
  }
  const categories = data.categories;
  if (categories && typeof categories === "object") {
    for (const surface of SURFACES) {
      const value = asScore(categories[surface]);
      if (value) {
        scores[surface] = value;
      }
    }
  }
  return Object.keys(scores).length ? scores : undefined;
}
