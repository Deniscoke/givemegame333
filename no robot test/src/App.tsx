import { useChallenges } from './hooks/useChallenges';
import CheckboxStage from './components/CheckboxStage';
import ImageGridChallenge from './components/ImageGridChallenge';
import MathChallenge from './components/MathChallenge';
import SequenceChallenge from './components/SequenceChallenge';
import ResultStage from './components/ResultStage';
import ProgressBar from './components/ProgressBar';

export default function App() {
  const {
    stage,
    attempts,
    score,
    currentChallenge,
    totalChallenges,
    imageGrid,
    targetCategory,
    mathChallenge,
    sequenceChallenge,
    startChallenge,
    toggleImageCell,
    verifyImageGrid,
    verifyMath,
    verifySequence,
    reset,
  } = useChallenges();

  const showProgress = !['checkbox', 'success', 'failed'].includes(stage);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-blue-50 to-indigo-100 flex items-center justify-center p-4">
      {/* Background decoration */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 -left-20 w-72 h-72 bg-blue-200/30 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 -right-20 w-96 h-96 bg-indigo-200/30 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-purple-100/20 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Main card */}
        <div className="bg-white/80 backdrop-blur-xl rounded-3xl shadow-xl shadow-black/5 border border-white/50 p-8">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <span className="font-bold text-gray-800 text-sm tracking-tight">HumanVerify</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs text-gray-400">Secure</span>
            </div>
          </div>

          {/* Progress bar */}
          {showProgress && (
            <div className="mb-6">
              <ProgressBar current={currentChallenge} total={totalChallenges} attempts={attempts} />
            </div>
          )}

          {/* Challenge content */}
          <div className="min-h-[320px] flex items-center justify-center">
            {stage === 'checkbox' && <CheckboxStage onStart={startChallenge} />}

            {stage === 'image-grid' && (
              <ImageGridChallenge
                grid={imageGrid}
                targetCategory={targetCategory}
                onToggle={toggleImageCell}
                onVerify={verifyImageGrid}
              />
            )}

            {stage === 'math' && mathChallenge && (
              <MathChallenge challenge={mathChallenge} onAnswer={verifyMath} />
            )}

            {stage === 'sequence' && sequenceChallenge && (
              <SequenceChallenge challenge={sequenceChallenge} onAnswer={verifySequence} />
            )}

            {stage === 'success' && (
              <ResultStage success score={score} total={totalChallenges} onReset={reset} />
            )}

            {stage === 'failed' && (
              <ResultStage success={false} score={score} total={totalChallenges} onReset={reset} />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-4 text-center">
          <p className="text-xs text-gray-400">
            Privacy — Terms — Help
          </p>
        </div>
      </div>
    </div>
  );
}
