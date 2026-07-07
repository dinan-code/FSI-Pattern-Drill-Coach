import type { AppSettings, FeedbackStatus } from "../types";

export interface ScoreResult {
  status: FeedbackStatus;
  score: number;
  normalizedAnswer: string;
  normalizedTarget: string;
}

const contractionMap: Record<string, string> = {
  "i'm": "i am",
  "you're": "you are",
  "he's": "he is",
  "she's": "she is",
  "it's": "it is",
  "we're": "we are",
  "they're": "they are",
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "won't": "will not",
  "wouldn't": "would not",
  "can't": "cannot",
  "i'll": "i will",
  "we'll": "we will",
  "they'll": "they will",
  "i'd": "i would",
  "you'd": "you would",
  "she'd": "she would",
  "he'd": "he would"
};

export function normalizeAnswer(value: string) {
  const lowered = value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, " ")
    .trim();

  const expanded = Object.entries(contractionMap).reduce(
    (text, [short, full]) => text.replace(new RegExp(`\\b${escapeRegExp(short)}\\b`, "g"), full),
    lowered
  );

  return expanded
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreAnswer(
  answer: string,
  target: string,
  strictness: AppSettings["strictness"]
): ScoreResult {
  const normalizedAnswer = normalizeAnswer(answer);
  const normalizedTarget = normalizeAnswer(target);

  if (!normalizedAnswer) {
    return {
      status: "retry",
      score: 0,
      normalizedAnswer,
      normalizedTarget
    };
  }

  if (normalizedAnswer === normalizedTarget) {
    return { status: "correct", score: 1, normalizedAnswer, normalizedTarget };
  }

  const similarity = normalizedSimilarity(normalizedAnswer, normalizedTarget);
  const tokenCoverage = coverageScore(normalizedAnswer, normalizedTarget);
  const score = Math.round(Math.max(similarity, tokenCoverage) * 100) / 100;

  const thresholds = {
    lenient: { correct: 0.88, almost: 0.72 },
    standard: { correct: 0.94, almost: 0.8 },
    strict: { correct: 0.99, almost: 0.9 }
  }[strictness];

  if (score >= thresholds.correct) {
    return { status: "correct", score: 1, normalizedAnswer, normalizedTarget };
  }

  if (score >= thresholds.almost) {
    return { status: "almost", score, normalizedAnswer, normalizedTarget };
  }

  return { status: "retry", score, normalizedAnswer, normalizedTarget };
}

export function getAccuracy(attempts: Array<{ status: FeedbackStatus }>) {
  if (attempts.length === 0) {
    return 0;
  }

  const weighted = attempts.reduce((sum, attempt) => {
    if (attempt.status === "correct") return sum + 1;
    if (attempt.status === "almost") return sum + 0.5;
    return sum;
  }, 0);

  return Math.round((weighted / attempts.length) * 100);
}

function normalizedSimilarity(a: string, b: string) {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;

  return 1 - levenshteinDistance(a, b) / maxLength;
}

function coverageScore(answer: string, target: string) {
  const answerTokens = new Set(answer.split(" ").filter(Boolean));
  const targetTokens = target.split(" ").filter(Boolean);
  if (targetTokens.length === 0) return 1;

  const matched = targetTokens.filter((token) => answerTokens.has(token)).length;
  return matched / targetTokens.length;
}

function levenshteinDistance(a: string, b: string) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitution
      );
    }
  }

  return matrix[a.length][b.length];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
