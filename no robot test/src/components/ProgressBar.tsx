interface Props {
  current: number;
  total: number;
  attempts: number;
}

export default function ProgressBar({ current, total, attempts }: Props) {
  return (
    <div className="w-full space-y-3">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>Challenge {current + 1} of {total}</span>
        <span className="flex items-center gap-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <span
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${
                i < attempts ? 'bg-red-400' : 'bg-gray-200'
              }`}
            />
          ))}
          <span className="ml-1">{3 - attempts} tries left</span>
        </span>
      </div>
      <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-blue-400 to-indigo-500 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${((current) / total) * 100}%` }}
        />
      </div>
    </div>
  );
}
