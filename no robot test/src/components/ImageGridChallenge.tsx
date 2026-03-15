import { cn } from '../utils/cn';
import type { ImageCell } from '../types';

interface Props {
  grid: ImageCell[];
  targetCategory: string;
  onToggle: (id: number) => void;
  onVerify: () => void;
}

export default function ImageGridChallenge({ grid, targetCategory, onToggle, onVerify }: Props) {
  return (
    <div className="flex flex-col items-center gap-5 w-full">
      <div className="text-center space-y-1">
        <h3 className="text-lg font-bold text-gray-800">Select all {targetCategory}</h3>
        <p className="text-gray-400 text-sm">Click on each tile that matches</p>
      </div>

      <div className="grid grid-cols-3 gap-2 w-full max-w-[280px]">
        {grid.map(cell => (
          <button
            key={cell.id}
            onClick={() => onToggle(cell.id)}
            className={cn(
              'aspect-square rounded-xl text-4xl flex items-center justify-center transition-all duration-200 border-2 cursor-pointer',
              cell.selected
                ? 'border-blue-500 bg-blue-50 scale-95 shadow-inner'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-md'
            )}
          >
            <span className={cn('transition-transform duration-200', cell.selected && 'scale-110')}>
              {cell.emoji}
            </span>
            {cell.selected && (
              <div className="absolute top-1 right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
          </button>
        ))}
      </div>

      <button
        onClick={onVerify}
        className="w-full max-w-[280px] py-3 bg-blue-500 text-white font-semibold rounded-xl hover:bg-blue-600 active:scale-[0.98] transition-all cursor-pointer shadow-md shadow-blue-500/20"
      >
        Verify Selection
      </button>
    </div>
  );
}
