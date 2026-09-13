import { useState, useRef, useEffect, ReactNode } from "react";

interface Option {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  className?: string;
  iconOnly?: ReactNode;
  icon?: ReactNode;
  hideLabel?: boolean;
  disabled?: boolean;
}

export default function CustomSelect({ value, options, onChange, className, iconOnly, icon, hideLabel, disabled = false }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const selectedLabel = options.find((o) => o.value === value)?.label || "";

  return (
    <div className={`custom-select${open ? " open" : ""}${disabled ? " disabled" : ""}${iconOnly ? " icon-only" : ""}${hideLabel ? " icon-no-border" : ""} ${className || ""}`} ref={ref}>
      <button className="custom-select-trigger" disabled={disabled} onClick={() => !disabled && setOpen(!open)} title={iconOnly || hideLabel ? selectedLabel : undefined}>
        {iconOnly ? (
          iconOnly
        ) : (
          <>
            {icon && <span className="custom-select-icon">{icon}</span>}
            {!hideLabel && <span>{selectedLabel}</span>}
            {!hideLabel && (
              <svg className="custom-select-chevron" viewBox="0 0 24 24" width="12" height="12">
                <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </>
        )}
      </button>
      {open && (
        <div className="custom-select-dropdown">
          {options.map((opt) => (
            <div
              key={opt.value}
              className={`custom-select-option${opt.value === value ? " selected" : ""}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
              {opt.value === value && (
                <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
