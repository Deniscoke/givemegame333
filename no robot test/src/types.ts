export type ChallengeType = 'checkbox' | 'image-grid' | 'math' | 'slider' | 'sequence' | 'success' | 'failed';

export interface ImageCell {
  id: number;
  emoji: string;
  isTarget: boolean;
  selected: boolean;
}

export interface MathChallenge {
  question: string;
  answer: number;
  options: number[];
}

export interface SequenceChallenge {
  sequence: number[];
  missingIndex: number;
  answer: number;
  options: number[];
}
