/**
 * Reject secrets and execution payloads before anything is written.
 *
 * Applied recursively to every tool argument. Keys that name a secret or an
 * execution field are refused outright; string values that look like a
 * credential (bearer tokens, GitHub/OpenAI-style keys, private key blocks)
 * are refused wherever they appear. Ordinary prose, URLs and paths pass.
 */
const SECRET_KEY = /(password|passwd|secret|token|cookie|authorization|api[_-]?key|credential|private[_-]?key)/i;
const EXECUTION_KEY = /(^|_)(command|cmd|shell|program|executable|argv|script|payload)(_|$)/i;
const LIKELY_SECRET = /(?:bearer\s+[A-Za-z0-9._~+/-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export class UnsafeInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeInput";
  }
}

export function assertSafe(value: unknown, trail = "input", depth = 0): void {
  if (depth > 12) throw new UnsafeInput(`Input nested too deeply at ${trail}`);
  if (typeof value === "string") {
    if (LIKELY_SECRET.test(value)) throw new UnsafeInput(`Credential-like value rejected at ${trail}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafe(item, `${trail}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new UnsafeInput(`Secret-like field rejected: ${trail}.${key}`);
    if (EXECUTION_KEY.test(key)) throw new UnsafeInput(`Execution field rejected: ${trail}.${key}`);
    assertSafe(child, `${trail}.${key}`, depth + 1);
  }
}
