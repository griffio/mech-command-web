// Case-insensitive access to a checkout of alariq/mc2srcdata. The original data
// was authored on Windows, so references rarely match the on-disk case.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Fit } from './fit.ts';

export class SourceData {
  private readonly index = new Map<string, string>();

  /**
   * Indexes the files on disk under `root`, or, when `listing` is given (paths as
   * printed by `git ls-tree`), the files that exist in the repository whether or
   * not they are checked out yet.
   */
  constructor(readonly root: string, listing?: string[]) {
    if (listing) {
      for (const rel of listing) this.index.set(normalize(rel), rel);
      return;
    }
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else this.index.set(normalize(relative(root, full)), relative(root, full).split(sep).join('/'));
      }
    };
    walk(root);
  }

  /** Repository-relative path with its real case, or null when it does not exist. */
  actual(rel: string): string | null {
    return this.index.get(normalize(rel)) ?? null;
  }

  /** Absolute path for a source-relative path, or null when it is not present. */
  resolve(rel: string): string | null {
    const actual = this.actual(rel);
    return actual ? join(this.root, actual) : null;
  }

  has(rel: string): boolean {
    return this.index.has(normalize(rel));
  }

  read(rel: string): Buffer {
    const path = this.resolve(rel);
    if (!path) throw new Error(`missing source file: ${rel}`);
    return readFileSync(path);
  }

  text(rel: string): string {
    return this.read(rel).toString('latin1');
  }

  fit(rel: string): Fit {
    return new Fit(this.text(rel));
  }

  /** objects/object2.rsp: line N names the .fit for object type number N. */
  objectList(): string[] {
    return this.text('objects/object2.rsp').split(/\r?\n/).map((l) => l.trim());
  }
}

function normalize(rel: string): string {
  return rel.split(sep).join('/').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}
