/**
 * OptionList — Radio-group style selection list (extracted from the
 * SpecifyStepper reference implementation, T-297).
 * @param {Array<{key:string,label:string,rationale?:string}>} options - Choices
 * @param {string|null} value - Selected option key (null = none)
 * @param {function} onChange - Called with the option key on selection
 * @param {string} [recommendedKey] - Option to mark as "recommended"
 * @param {string} [className] - Extra classes for the group container
 * @example <OptionList options={opts} value={sel} onChange={setSel} recommendedKey="A" />
 */
export default function OptionList({
  options = [],
  value = null,
  onChange,
  recommendedKey,
  className = '',
}) {
  if (options.length === 0) return null;
  return (
    <div className={['space-y-2', className].join(' ')} role="radiogroup">
      {options.map((opt) => {
        const isSelected = value === opt.key;
        const isRecommended = recommendedKey === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange?.(opt.key)}
            className={`w-full text-left p-3 rounded-md border cursor-pointer transition-colors ${
              isSelected
                ? 'bg-bg-elevated border-accent'
                : 'bg-transparent border-border hover:border-border-strong hover:bg-bg-accent'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full border shrink-0 ${
                isSelected ? 'border-accent' : 'border-border-strong'
              }`}>
                {isSelected && <span className="w-2 h-2 rounded-full bg-accent" />}
              </span>
              <span className={`text-sm font-medium ${isSelected ? 'text-text-strong' : 'text-text'}`}>
                {opt.key}: {opt.label}
                {isRecommended && <span className="ml-2 text-xs font-normal text-accent-2">recommended</span>}
              </span>
            </div>
            {opt.rationale && (
              <p className="text-xs text-muted m-0 mt-1 ml-6">{opt.rationale}</p>
            )}
          </button>
        );
      })}
    </div>
  );
}
