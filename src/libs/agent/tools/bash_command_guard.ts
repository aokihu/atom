export type BashCommandSafetyResult =
  | { ok: true }
  | { ok: false; ruleId: string; message: string };

type GuardRule = {
  id: string;
  message: string;
  patterns: RegExp[];
};

const normalizeCommandForMatching = (command: string) => {
  let normalized = command.toLowerCase().replace(/\s+/g, " ").trim();

  // Strip repeated sudo prefixes so `sudo sudo rm -rf /` matches the same rule.
  while (normalized.startsWith("sudo ")) {
    normalized = normalized.slice(5).trimStart();
  }

  return normalized;
};

const BLOCK_DEVICE_REGEX =
  /\/dev\/(?:sd[a-z][a-z0-9]*|nvme\d+n\d+(?:p\d+)?|vd[a-z][a-z0-9]*|xvd[a-z][a-z0-9]*)\b/;

const DANGEROUS_COMMAND_RULES: GuardRule[] = [
  {
    id: "root-rm-rf",
    message: "Destructive root filesystem deletion command is blocked",
    patterns: [
      /\brm\s+-rf\s+\/(?:\s|$)/,
      /\brm\s+-fr\s+\/(?:\s|$)/,
      /\brm\s+-rf\s+\/\*(?:\s|$)/,
      /\brm\s+-rf\s+--no-preserve-root\s+\/(?:\s|$)/,
      /\brm\s+-rf\s+\/\s+--no-preserve-root(?:\s|$)/,
    ],
  },
  {
    id: "system-power-command",
    message: "System power/reboot commands are blocked",
    patterns: [
      /\bshutdown\b/,
      /\breboot\b/,
      /\bhalt\b/,
      /\bpoweroff\b/,
      /\binit\s+0\b/,
      /\bsystemctl\s+(?:reboot|poweroff|halt)\b/,
    ],
  },
  {
    id: "disk-format-or-partition",
    message: "Disk formatting and partitioning commands are blocked",
    patterns: [
      /\bmkfs(?:\.[a-z0-9_-]+)?\b/,
      /\bfdisk\b/,
      /\bsfdisk\b/,
      /\bparted\b/,
      /\bwipefs\b/,
    ],
  },
  {
    id: "dd-to-block-device",
    message: "dd writes to block devices are blocked",
    patterns: [/\bdd\b[^\n]*\bof=\/dev\/[^\s;|&]+/],
  },
  {
    id: "shred-device",
    message: "Shred on raw devices is blocked",
    patterns: [/\bshred\b[^\n]*\s\/dev\/[^\s;|&]+/],
  },
  {
    id: "redirect-to-block-device",
    message: "Direct writes to block devices are blocked",
    patterns: [/>+\s*\/dev\/[^\s;|&]+/],
  },
  {
    id: "sysrq-trigger",
    message: "Writing to /proc/sysrq-trigger is blocked",
    patterns: [/\/proc\/sysrq-trigger\b/],
  },
  {
    id: "kill-all-processes",
    message: "kill -9 -1 is blocked",
    patterns: [/\bkill\s+-9\s+-1\b/, /\bkill\s+-kill\s+-1\b/],
  },
  {
    id: "fork-bomb",
    message: "Fork bomb pattern is blocked",
    patterns: [/:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/],
  },
];

const patternMatches = (pattern: RegExp, text: string, ruleId: string) => {
  if (!pattern.test(text)) {
    return false;
  }

  if (ruleId === "dd-to-block-device" || ruleId === "redirect-to-block-device") {
    return BLOCK_DEVICE_REGEX.test(text);
  }

  if (ruleId === "shred-device") {
    return /\/dev\//.test(text);
  }

  return true;
};

const matchDangerousRule = (command: string): BashCommandSafetyResult | null => {
  for (const rule of DANGEROUS_COMMAND_RULES) {
    for (const pattern of rule.patterns) {
      if (patternMatches(pattern, command, rule.id)) {
        return {
          ok: false,
          ruleId: rule.id,
          message: rule.message,
        };
      }
    }
  }

  return null;
};

export const validateBashCommandSafety = (command: string): BashCommandSafetyResult => {
  const raw = command ?? "";
  const normalized = normalizeCommandForMatching(raw);

  return (
    matchDangerousRule(raw) ??
    matchDangerousRule(normalized) ?? {
      ok: true,
    }
  );
};

