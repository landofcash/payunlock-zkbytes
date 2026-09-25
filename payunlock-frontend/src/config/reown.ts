export function readReownProjectId(value: unknown): string | null {
  return typeof value === "string" &&
    /^[a-f0-9]{32}$/i.test(value.trim()) &&
    !/^0+$/.test(value.trim())
    ? value.trim()
    : null;
}
export const reownProjectId = readReownProjectId(
  import.meta.env.VITE_REOWN_PROJECT_ID,
);
