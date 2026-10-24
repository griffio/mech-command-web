// Reader for MC2 "FITini" text files: [Section] blocks of `type Key = value`
// lines. Keys and section names are matched case-insensitively, like the engine.

export class Fit {
  readonly sections = new Map<string, Map<string, string>>();

  constructor(text: string) {
    let current: Map<string, string> | null = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('//')) continue;
      const section = /^\[([^\]]+)\]/.exec(line);
      if (section) {
        current = new Map();
        this.sections.set(section[1].trim().toLowerCase(), current);
        continue;
      }
      // Optional type prefix: st, f, l, ul, uc, b, c, l[15], ...
      const kv = /^(?:[a-z]+(?:\[\d+\])?\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/.exec(line);
      if (!kv || !current) continue;
      current.set(kv[1].toLowerCase(), parseValue(kv[2]));
    }
  }

  has(section: string): boolean {
    return this.sections.has(section.toLowerCase());
  }

  get(section: string, key: string): string | undefined {
    return this.sections.get(section.toLowerCase())?.get(key.toLowerCase());
  }

  str(section: string, key: string, fallback = ''): string {
    return this.get(section, key) ?? fallback;
  }

  num(section: string, key: string, fallback = 0): number {
    const v = this.get(section, key);
    if (v === undefined) return fallback;
    const n = /^-?0x/i.test(v) ? parseInt(v, 16) : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  bool(section: string, key: string, fallback = false): boolean {
    const v = this.get(section, key);
    if (v === undefined) return fallback;
    return /^(true|1|yes)$/i.test(v);
  }
}

function parseValue(rest: string): string {
  const s = rest.trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end < 0 ? s.slice(1) : s.slice(1, end);
  }
  const comment = s.indexOf('//');
  return (comment >= 0 ? s.slice(0, comment) : s).trim();
}
