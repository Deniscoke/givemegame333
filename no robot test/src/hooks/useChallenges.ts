import { useState, useCallback } from 'react';
import type { ChallengeType, ImageCell, MathChallenge, SequenceChallenge } from '../types';

const EMOJI_CATEGORIES: Record<string, string[]> = {
  animals: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮'],
  fruits: ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍒', '🍑', '🥭', '🍍'],
  vehicles: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚'],
  flowers: ['🌸', '🌹', '🌺', '🌻', '🌼', '🌷', '💐', '🪻', '🌾', '🪷', '🌿', '🍀'],
  food: ['🍕', '🍔', '🌭', '🍟', '🌮', '🌯', '🥪', '🍩', '🍪', '🎂', '🧁', '🍰'],
  sports: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🥊', '⛳'],
};

const CATEGORY_LABELS: Record<string, string> = {
  animals: 'animals',
  fruits: 'fruits',
  vehicles: 'vehicles',
  flowers: 'flowers',
  food: 'food',
  sports: 'sports items',
};

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function useChallenges() {
  const [stage, setStage] = useState<ChallengeType>('checkbox');
  const [attempts, setAttempts] = useState(0);
  const [score, setScore] = useState(0);
  const [currentChallenge, setCurrentChallenge] = useState(0);
  const totalChallenges = 3;

  // Image grid state
  const [imageGrid, setImageGrid] = useState<ImageCell[]>([]);
  const [targetCategory, setTargetCategory] = useState('');

  // Math state
  const [mathChallenge, setMathChallenge] = useState<MathChallenge | null>(null);

  // Sequence state
  const [sequenceChallenge, setSequenceChallenge] = useState<SequenceChallenge | null>(null);

  // Slider state
  const [sliderTarget, setSliderTarget] = useState(0);

  const generateImageGrid = useCallback(() => {
    const categoryKeys = Object.keys(EMOJI_CATEGORIES);
    const targetKey = categoryKeys[randomInt(0, categoryKeys.length - 1)];
    const otherKeys = categoryKeys.filter(k => k !== targetKey);

    const targetEmojis = shuffle(EMOJI_CATEGORIES[targetKey]).slice(0, randomInt(3, 5));
    const fillerCount = 9 - targetEmojis.length;

    const fillerEmojis: string[] = [];
    const usedOtherKeys = shuffle(otherKeys).slice(0, 3);
    for (let i = 0; i < fillerCount; i++) {
      const key = usedOtherKeys[i % usedOtherKeys.length];
      const emojis = EMOJI_CATEGORIES[key];
      fillerEmojis.push(emojis[randomInt(0, emojis.length - 1)]);
    }

    const cells: ImageCell[] = shuffle([
      ...targetEmojis.map((emoji, i) => ({ id: i, emoji, isTarget: true, selected: false })),
      ...fillerEmojis.map((emoji, i) => ({ id: targetEmojis.length + i, emoji, isTarget: false, selected: false })),
    ]).map((cell, index) => ({ ...cell, id: index }));

    setImageGrid(cells);
    setTargetCategory(CATEGORY_LABELS[targetKey]);
  }, []);

  const generateMath = useCallback(() => {
    const a = randomInt(2, 15);
    const b = randomInt(2, 15);
    const ops = [
      { symbol: '+', result: a + b },
      { symbol: '-', result: a - b },
      { symbol: '×', result: a * b },
    ];
    const op = ops[randomInt(0, 2)];
    const answer = op.result;
    const wrongAnswers = new Set<number>();
    while (wrongAnswers.size < 3) {
      const wrong = answer + randomInt(-5, 5);
      if (wrong !== answer) wrongAnswers.add(wrong);
    }
    setMathChallenge({
      question: `${a} ${op.symbol} ${b} = ?`,
      answer,
      options: shuffle([answer, ...Array.from(wrongAnswers)]),
    });
  }, []);

  const generateSequence = useCallback(() => {
    const start = randomInt(1, 10);
    const step = randomInt(2, 5);
    const sequence = Array.from({ length: 6 }, (_, i) => start + step * i);
    const missingIndex = randomInt(1, 4);
    const answer = sequence[missingIndex];
    const wrongAnswers = new Set<number>();
    while (wrongAnswers.size < 3) {
      const wrong = answer + randomInt(-step * 2, step * 2);
      if (wrong !== answer && wrong > 0) wrongAnswers.add(wrong);
    }
    setSequenceChallenge({
      sequence,
      missingIndex,
      answer,
      options: shuffle([answer, ...Array.from(wrongAnswers)]),
    });
  }, []);

  const startChallenge = useCallback(() => {
    setCurrentChallenge(0);
    setScore(0);
    setAttempts(0);
    nextChallenge(0);
  }, []);

  const nextChallenge = useCallback((index: number) => {
    const challenges: ChallengeType[] = shuffle(['image-grid', 'math', 'sequence']);
    const next = challenges[index % challenges.length];
    setStage(next);

    if (next === 'image-grid') generateImageGrid();
    else if (next === 'math') generateMath();
    else if (next === 'sequence') generateSequence();
    else if (next === 'slider') setSliderTarget(randomInt(60, 90));
  }, [generateImageGrid, generateMath, generateSequence]);

  const handleSuccess = useCallback(() => {
    const next = currentChallenge + 1;
    const newScore = score + 1;
    setScore(newScore);
    setCurrentChallenge(next);

    if (next >= totalChallenges) {
      setStage('success');
    } else {
      nextChallenge(next);
    }
  }, [currentChallenge, score, nextChallenge, totalChallenges]);

  const handleFailure = useCallback(() => {
    const newAttempts = attempts + 1;
    setAttempts(newAttempts);

    if (newAttempts >= 3) {
      setStage('failed');
    } else {
      nextChallenge(currentChallenge);
    }
  }, [attempts, currentChallenge, nextChallenge]);

  const toggleImageCell = useCallback((id: number) => {
    setImageGrid(prev => prev.map(cell =>
      cell.id === id ? { ...cell, selected: !cell.selected } : cell
    ));
  }, []);

  const verifyImageGrid = useCallback(() => {
    const allCorrect = imageGrid.every(cell => cell.selected === cell.isTarget);
    if (allCorrect) handleSuccess();
    else handleFailure();
  }, [imageGrid, handleSuccess, handleFailure]);

  const verifyMath = useCallback((answer: number) => {
    if (mathChallenge && answer === mathChallenge.answer) handleSuccess();
    else handleFailure();
  }, [mathChallenge, handleSuccess, handleFailure]);

  const verifySequence = useCallback((answer: number) => {
    if (sequenceChallenge && answer === sequenceChallenge.answer) handleSuccess();
    else handleFailure();
  }, [sequenceChallenge, handleSuccess, handleFailure]);

  const reset = useCallback(() => {
    setStage('checkbox');
    setAttempts(0);
    setScore(0);
    setCurrentChallenge(0);
  }, []);

  return {
    stage,
    attempts,
    score,
    currentChallenge,
    totalChallenges,
    imageGrid,
    targetCategory,
    mathChallenge,
    sequenceChallenge,
    sliderTarget,
    startChallenge,
    toggleImageCell,
    verifyImageGrid,
    verifyMath,
    verifySequence,
    handleSuccess,
    handleFailure,
    reset,
  };
}
