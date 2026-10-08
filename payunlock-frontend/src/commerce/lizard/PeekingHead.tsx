import { useId } from "react";

// Reuse the mascot's head and eyes, rotated and cropped at the page edge.
export function PeekingHead() {
  const id = useId();
  return <svg viewBox="163 54 60 94" width="24" height="37.5" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-skin`} x1="140" y1="140" x2="194" y2="55" gradientUnits="userSpaceOnUse">
        <stop stopColor="#51894b" /><stop offset=".55" stopColor="#88b95d" /><stop offset="1" stopColor="#a9cc70" />
      </linearGradient>
      <radialGradient id={`${id}-iris`} cx=".4" cy=".35" r=".7">
        <stop stopColor="#ede4a7" /><stop offset=".6" stopColor="#c7b970" /><stop offset="1" stopColor="#897b41" />
      </radialGradient>
    </defs>
    <g transform="rotate(90 176 101)">
      <path d="M176 56 C188 56 201 66 207 78 C215 92 218 108 210 123 C203 137 191 144 178 146 C164 144 150 137 142 123 C134 108 138 92 146 78 C153 66 165 56 176 56Z" fill={`url(#${id}-skin)`} stroke="#4d8042" strokeWidth="1.5" />
      <path d="M165 66 Q176 60 187 68 Q196 78 197 88 Q192 100 178 106 Q162 101 156 88 Q156 77 165 66Z" fill="#bfda88" opacity=".28" />
      <path d="M157 77 Q162 67 169 65" fill="none" stroke="#d3e5a1" strokeWidth="2.8" opacity=".65" strokeLinecap="round" />
      {[false, true].map(right => <g key={String(right)} transform={right ? "translate(205 96) rotate(-18)" : "translate(148 96) rotate(18)"}>
        <ellipse rx="10.5" ry="14" fill="#497a3d" />
        <ellipse cy="-1.2" rx="7.5" ry="10.4" fill={`url(#${id}-iris)`} />
        <ellipse cx={right ? -.8 : .8} cy="-3" rx="4.9" ry="6.8" fill="#192e23" />
        <ellipse cx={right ? -2.4 : 2.4} cy="-6.5" rx="1.5" ry="2" fill="#fffce1" />
        <path d={right ? "M9 -6 Q3 -16 -6 -10" : "M-9 -6 Q-3 -16 6 -10"} fill="none" stroke="#aaca75" strokeWidth="3" strokeLinecap="round" />
      </g>)}
      <ellipse cx="170" cy="69" rx="1.5" ry="1" fill="#4e753a" transform="rotate(-25 170 69)" />
      <ellipse cx="183" cy="69" rx="1.5" ry="1" fill="#4e753a" transform="rotate(25 183 69)" />
    </g>
  </svg>;
}
