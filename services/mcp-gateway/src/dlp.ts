// DLP: mask secrets in tool results before they reach the agent (instructions.md §13.5, §9.3).
// Regex-based redaction of the high-signal secret shapes. Returns the masked text
// plus which categories were hit (audited, never the secret itself).

const PATTERNS: Array<[string, RegExp]> = [
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github_token", /\bghp_[A-Za-z0-9]{36}\b/g],
  // App-installation (ghs_ = Mode B org credential), OAuth (gho_), user (ghu_), refresh (ghr_).
  ["github_app_token", /\bgh[osur]_[A-Za-z0-9]{36,}\b/g],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  // The Anthropic model key this platform now injects — DLP must cover its own live secret.
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["private_key", /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi],
  ["password_kv", /\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi],
];

export interface DlpResult {
  text: string;
  redacted: string[]; // category names hit
}

export function scrub(input: string): DlpResult {
  let text = input;
  const redacted: string[] = [];
  for (const [name, rx] of PATTERNS) {
    if (rx.test(text)) {
      redacted.push(name);
      text = text.replace(rx, `[REDACTED:${name}]`);
    }
    rx.lastIndex = 0;
  }
  return { text, redacted };
}

export interface FileFinding {
  category: string;
  line: number; // 1-indexed
}

// Scan a generated file for secrets before it leaves the sandbox (§9.3: "gitleaks
// en mode librairie"). Reports findings by line; the caller blocks or strips the
// file. Same pattern set as `scrub`, but read-only (we don't mutate the file here).
export function scanFile(content: string): FileFinding[] {
  const findings: FileFinding[] = [];
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    for (const [name, rx] of PATTERNS) {
      if (rx.test(line)) findings.push({ category: name, line: i + 1 });
      rx.lastIndex = 0;
    }
  });
  return findings;
}

// Guard applied to memory.save content and any agent-authored durable text
// (§9.1.3, §13.5): the same DLP that protects outbound results must protect what
// the agent writes to memory. Returns the scrubbed content + whether it was clean.
export function guardMemoryWrite(content: string): { clean: boolean; content: string; redacted: string[] } {
  const r = scrub(content);
  return { clean: r.redacted.length === 0, content: r.text, redacted: r.redacted };
}
