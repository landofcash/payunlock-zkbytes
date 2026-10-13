import {useEffect, useRef, useState} from "react";
import {Check, Copy} from "lucide-react";
import {Button} from "@/components/ui/button";

type CopyableFieldProps = { value: string; label?: string; displayValue?: string; hideLabel?: boolean };

export function CopyableField({value, label = "Value", displayValue, hideLabel = false}: CopyableFieldProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<string | null>(value);
  useEffect(() => {
    current.current = value;
    setStatus("idle");
    return () => {
      current.current = null;
      clearTimeout(timer.current);
    };
  }, [value]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      if (current.current !== value) return;
      clearTimeout(timer.current);
      setStatus("copied");
      timer.current = setTimeout(() => setStatus("idle"), 1500);
    } catch {
      if (current.current === value) {
        clearTimeout(timer.current);
        setStatus("error");
      }
    }
  }

  return <div className="copyable-field">{!hideLabel && <span className="copyable-label">{label}</span>}<Button
    icon={status === "copied" ? Check : Copy} variant="ghost" className="copyable-value"
    aria-label={`Copy ${label.toLowerCase()}`} title={value}
    onClick={() => void copy()}><span>{displayValue ?? value}</span></Button><span className="copyable-feedback"
                                                                                   role="status">{status === "copied" ? "Copied!" : status === "error" ? "Could not copy. Select and copy the text manually." : ""}</span>
  </div>;
}
