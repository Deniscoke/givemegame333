import { useState } from 'react';
import { cn } from '../utils/cn';

interface Props {
  onStart: () => void;
}

export default function CheckboxStage({ onStart }: Props) {
  const [checked, setChecked] = useState(false);
  const [animating, setAnimating] = useState(false);

  const handleClick = () => {
    setChecked(true);
    setAnimating(true);
    setTimeout(() => {
      onStart();
    }, 1200);
  };

  return (
    <div className="flex flex-col items-center gap-8">
      <div className="text-center space-y-2">
        <div className="text-5xl mb-4">🛡️</div>
        <h2 className="text-2xl font-bold text-gray-800">Security Check</h2>
        <p className="text-gray-500 text-sm max-w-xs">
          Please verify that you are a human by completing the challenges below.
        </p>
      </div>

      <button
        onClick={handleClick}
        disabled={checked}
        className={cn(
          'group flex items-center gap-4 px-8 py-5 rounded-xl border-2 transition-all duration-300 w-full max-w-sm',
          checked
            ? 'border-blue-400 bg-blue-50'
            : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-lg cursor-pointer'
        )}
      >
        <div
          className={cn(
            'w-7 h-7 rounded-md border-2 flex items-center justify-center transition-all duration-300',
            checked
              ? 'border-blue-500 bg-blue-500'
              : 'border-gray-300 group-hover:border-blue-400'
          )}
        >
          {checked && (
            <svg className="w-4 h-4 text-white animate-[scale-in_0.3s_ease-out]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
        <span className="text-gray-700 font-medium text-lg">I'm not a robot</span>

        {animating && (
          <div className="ml-auto">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </button>

      <div className="flex items-center gap-2 text-xs text-gray-400">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <span>Protected by HumanVerify™</span>
      </div>
    </div>
  );
}
