// Adapted from Magic UI (MIT); see licenses/magicui.txt.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type ComponentPropsWithRef } from "react";
import confetti, { type CreateTypes, type GlobalOptions, type Options } from "canvas-confetti";

export type ConfettiRef = { fire: (options?: Options) => Promise<void> | void };
type ConfettiProps = ComponentPropsWithRef<"canvas"> & { options?: Options; globalOptions?: GlobalOptions };

export const Confetti = forwardRef<ConfettiRef, ConfettiProps>(function Confetti({ options, globalOptions, ...canvasProps }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceRef = useRef<CreateTypes | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!canvasRef.current) return;
    try { instanceRef.current = confetti.create(canvasRef.current, { resize: true, useWorker: true, ...globalOptions }); }
    catch { instanceRef.current = null; }
    return () => { instanceRef.current?.reset(); instanceRef.current = null; };
  }, []);

  const fire = useCallback(async (next?: Options) => { await instanceRef.current?.({ ...optionsRef.current, ...next }); }, []);
  useImperativeHandle(ref, () => ({ fire }), [fire]);
  return <canvas ref={canvasRef} {...canvasProps} />;
});
