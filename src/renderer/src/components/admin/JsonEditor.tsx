import React, { useState, useEffect, useRef } from "react";

interface JsonEditorProps<T> {
  value: T;
  onChange: (newValue: T) => void;
  title?: string;
  /** What is wrong with a parsed value (null: it may be taken) — nothing is taken that this refuses */
  validate?: (value: unknown) => string | null;
}

const isObject = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? null : "It must be an object: { … }");

export function JsonEditor<T extends object>({
  value,
  onChange,
  title = "JSON",
  validate = isObject,
}: JsonEditorProps<T>) {
  const [jsonText, setJsonText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isEditingRef = useRef(false);

  // Sync external state changes into jsonText when user is not typing in the textarea
  useEffect(() => {
    if (!isEditingRef.current) {
      setJsonText(JSON.stringify(value, null, 2));
      setError(null);
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setJsonText(text);
    isEditingRef.current = true;

    try {
      const parsed = JSON.parse(text);
      const problem = validate(parsed);
      if (!problem) {
        setError(null);
        onChange(parsed as T);
      } else {
        setError(problem);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Not valid JSON";
      setError(msg);
    }
  };

  const handleBlur = () => {
    isEditingRef.current = false;
    try {
      const parsed = JSON.parse(jsonText);
      setJsonText(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch {
      // Keep current text and error state if invalid
    }
  };

  const handleFormat = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const problem = validate(parsed);
      setJsonText(JSON.stringify(parsed, null, 2));
      setError(problem);
      if (!problem) onChange(parsed as T);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Not valid JSON";
      setError(msg);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <details className="group">
      <summary className="flex items-center justify-between text-xs font-medium uppercase tracking-widest text-[var(--text-subtitle)] cursor-pointer select-none list-none hover:text-[var(--text-p)] transition-colors duration-150 py-1">
        <div className="flex items-center gap-2">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className="transition-transform duration-200 group-open:rotate-90"
          >
            <path
              d="M4 2l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{title}</span>
          {error ? (
            <span className="normal-case text-[10px] tracking-normal px-2 py-0.5 rounded-full bg-red-500/10 text-red-500 font-mono">
              Syntax error
            </span>
          ) : (
            <span className="normal-case text-[10px] tracking-normal px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 font-mono">
              Editable
            </span>
          )}
        </div>
      </summary>

      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--text-subtitle)] font-mono truncate">
            {error ? (
              <span className="text-red-500 font-medium">{error}</span>
            ) : (
              "Changes show in the live preview at once."
            )}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleFormat}
              className="text-xs px-2.5 py-1 rounded-md border border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-subtitle)] hover:text-[var(--text-p)] hover:bg-[var(--bg-4)] transition-colors duration-150 cursor-pointer"
            >
              Format
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="text-xs px-2.5 py-1 rounded-md border border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-subtitle)] hover:text-[var(--text-p)] hover:bg-[var(--bg-4)] transition-colors duration-150 cursor-pointer"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        <textarea
          value={jsonText}
          onChange={handleChange}
          onBlur={handleBlur}
          spellCheck={false}
          rows={14}
          className={`w-full rounded-xl border p-4 font-mono text-xs leading-6 text-[var(--text-p)] bg-[var(--bg-2)] resize-y focus:outline-none transition-colors duration-150 ${
            error
              ? "border-red-500/50 focus:border-red-500"
              : "border-[var(--border)] focus:border-[var(--text-subtitle)]"
          }`}
        />
      </div>
    </details>
  );
}
