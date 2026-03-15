interface Props {
  success: boolean;
  score: number;
  total: number;
  onReset: () => void;
}

export default function ResultStage({ success, score, total, onReset }: Props) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className={`text-7xl ${success ? 'animate-bounce' : 'animate-pulse'}`}>
        {success ? '✅' : '🤖'}
      </div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-gray-800">
          {success ? 'Verification Complete!' : 'Verification Failed'}
        </h2>
        <p className="text-gray-500 text-sm max-w-xs">
          {success
            ? 'You have been verified as a human. You may now proceed.'
            : 'Too many incorrect attempts. Please try again.'}
        </p>
      </div>

      <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 rounded-full">
        <span className="text-sm text-gray-500">Score:</span>
        <span className="text-sm font-bold text-gray-700">
          {score}/{total}
        </span>
      </div>

      {success ? (
        <div className="w-full max-w-sm space-y-3">
          <div className="flex items-center gap-3 p-4 bg-green-50 border border-green-200 rounded-xl">
            <svg className="w-5 h-5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <div className="text-left">
              <p className="text-sm font-semibold text-green-800">Access Granted</p>
              <p className="text-xs text-green-600">Session verified • Human confirmed</p>
            </div>
          </div>
          <button
            onClick={onReset}
            className="text-sm text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
          >
            Verify again
          </button>
        </div>
      ) : (
        <button
          onClick={onReset}
          className="px-8 py-3 bg-red-500 text-white font-semibold rounded-xl hover:bg-red-600 active:scale-[0.98] transition-all cursor-pointer shadow-md shadow-red-500/20"
        >
          Try Again
        </button>
      )}
    </div>
  );
}
