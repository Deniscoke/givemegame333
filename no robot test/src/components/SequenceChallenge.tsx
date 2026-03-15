import { cn } from '../utils/cn';
import type { SequenceChallenge as SequenceChallengeType } from '../types';

interface Props {
  challenge: SequenceChallengeType;
  onAnswer: (answer: number) => void;
}

export default function SequenceChallenge({ challenge, onAnswer }: Props) {
  return (
    <div className="flex flex-col items-center gap-6 w-full">
      <div className="text-center space-y-1">
        <h3 className="text-lg font-bold text-gray-800">Find the missing number</h3>
        <p className="text-gray-400 text-sm">What number completes the pattern?</p>
      </div>

      <div className="flex items-center gap-2 flex-wrap justify-center w-full max-w-[340px]">
        {challenge.sequence.map((num, i) => (
          <div key={i} className="flex items-center gap-2">
            {i === challenge.missingIndex ? (
              <div className="w-14 h-14 rounded-xl border-2 border-dashed border-amber-400 bg-amber-50 flex items-center justify-center">
                <span className="text-2xl text-amber-400 font-bold">?</span>
              </div>
            ) : (
              <div className="w-14 h-14 rounded-xl border-2 border-gray-200 bg-white flex items-center justify-center shadow-sm">
                <span className="text-xl font-bold text-gray-700">{num}</span>
              </div>
            )}
            {i < challenge.sequence.length - 1 && (
              <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 w-full max-w-[280px]">
        {challenge.options.map((option, i) => (
          <button
            key={i}
            onClick={() => onAnswer(option)}
            className={cn(
              'py-4 px-6 rounded-xl font-bold text-xl border-2 transition-all duration-200 cursor-pointer',
              'border-gray-200 bg-white text-gray-700 hover:border-amber-400 hover:bg-amber-50 hover:shadow-md active:scale-95'
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
