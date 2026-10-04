// Settings form helpers: check a number field against its limits, and detect unsaved changes.

export function numberError(raw, min, max) {
  const text = String(raw).trim();
  const n = Number(text);
  const ok = text !== "" && Number.isInteger(n) && n >= min && n <= max;
  return ok ? null : `Enter a whole number from ${min} to ${max}.`;
}

export function isDirty(saved, current) {
  return JSON.stringify(saved) !== JSON.stringify(current);
}
