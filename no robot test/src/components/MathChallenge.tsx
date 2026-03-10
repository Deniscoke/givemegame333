import { cn } from '../utils/cn';
import type { MathChallenge as MathChallengeType } from '../types';

interface Props {
  challenge: MathChallengeType;
  onAnswer: (answer: number) => void;
}

export default function MathChallenge({ challenge, onAnswer }: Props) {
  return (
    <div className="flex flex-col items-center gap-6 w-full">
      <div className="text-center space-y-1">
        <h3 className="text-lg font-bold text-gray-800">Solve the equation</h3>
        <p className="text-gray-400 text-sm">Select the correct answer</p>
      </div>

      <div className="bg-gradient-to-br from-indigo-50 to-blue-50 rounded-2xl p-8 w-full max-w-[300px] text-center border border-indigo-100">
        <span className="text-4xl font-bold text-indigo-700 font-mono tracking-wider">
          {challenge.question}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 w-full max-w-[300px]">
        {challenge.options.map((option, i) => (
          <button
            key={i}
            onClick={() => onAnswer(option)}
            className={cn(
              'py-4 px-6 rounded-xl font-bold text-xl border-2 transition-all duration-200 cursor-pointer',
              'border-gray-200 bg-white text-gray-700 hover:border-indigo-400 hover:bg-indigo-50 hover:shadow-md active:scale-95'
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
