export type DrillMode = "substitution" | "transformation";

export type FeedbackStatus = "idle" | "correct" | "almost" | "retry" | "revealed";

export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export type TransformationKind =
  | "negative"
  | "question"
  | "past"
  | "future"
  | "thirdPerson"
  | "plural"
  | "polite";

export interface SubstitutionCue {
  id: string;
  cue: string;
  target: string;
  hint?: string;
}

export interface TransformationCue {
  id: string;
  type: TransformationKind;
  cue: string;
  target: string;
}

export interface DrillSet {
  id: string;
  title: string;
  level: CefrLevel;
  focus: string;
  baseSentence: string;
  substitutionSlot: string;
  substitution: SubstitutionCue[];
  transformation: TransformationCue[];
}

export interface AttemptRecord {
  setId: string;
  mode: DrillMode;
  prompt: string;
  target: string;
  answer: string;
  status: FeedbackStatus;
  score: number;
  elapsedMs: number;
  createdAt: string;
}

export interface DrillProgress {
  attempts: AttemptRecord[];
  completedSets: string[];
  lastSetId: string;
}

export interface AppSettings {
  autoSpeak: boolean;
  autoAdvance: boolean;
  voiceLoop: boolean;
  showBaseSentence: boolean;
  strictness: "lenient" | "standard" | "strict";
  pace: "slow" | "standard" | "fast";
}
