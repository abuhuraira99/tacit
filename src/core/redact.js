/**
 * Secret redaction. Applied to every prompt before it is cached, displayed or exported,
 * so keys pasted into a session never reach the UI, a report, or a generated file.
 */
const RULES = [
  // Anthropic, OpenAI and similar provider keys
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[redacted:anthropic-key]'],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, '[redacted:api-key]'],
  // GitHub tokens
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted:github-token]'],
  // Slack, Stripe, Google
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted:slack-token]'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '[redacted:stripe-key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted:google-key]'],
  // AWS
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted:aws-key]'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted:jwt]'],
  // Private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  // Credentials inside URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  // key=value / key: value assignments for obviously secret names
  [
    /\b((?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key|auth)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    '$1[redacted]',
  ],
  // Bearer headers
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted]'],
];

export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

export function containsSecret(text) {
  return redact(text) !== text;
}
