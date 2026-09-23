/** Local editor aids. These records never publish or confirm document versions. */
export class EditHistory<T> {
  private entries: T[] = [];
  private index = -1;
  private group = "";
  private at = 0;
  constructor(private readonly limit = 80, private readonly key: (value: T) => string = JSON.stringify) {}
  reset(value: T): void { this.entries = [structuredClone(value)]; this.index = 0; this.breakGroup(); }
  breakGroup(): void { this.group = ""; this.at = 0; }
  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index >= 0 && this.index < this.entries.length - 1; }
  current(): T | undefined { return this.index < 0 ? undefined : structuredClone(this.entries[this.index]!); }
  record(value: T, group = "", now = Date.now()): boolean {
    if (this.index < 0) { this.reset(value); return false; }
    if (this.key(this.entries[this.index]!) === this.key(value)) return false;
    const merge = group && group === this.group && now - this.at < 800 && this.index > 0 && !this.canRedo;
    this.entries.splice(this.index + 1);
    if (merge) this.entries[this.index] = structuredClone(value);
    else { this.entries.push(structuredClone(value)); this.index++; }
    if (this.entries.length > this.limit) { this.entries.shift(); this.index--; }
    this.group = group; this.at = now;
    return true;
  }
  replaceCurrent(value: T): void { if (this.index < 0) this.reset(value); else this.entries[this.index] = structuredClone(value); this.breakGroup(); }
  undo(): T | undefined { if (!this.canUndo) return; this.index--; this.breakGroup(); return this.current(); }
  redo(): T | undefined { if (!this.canRedo) return; this.index++; this.breakGroup(); return this.current(); }
}

export type ReviewPlace = { id: string; sourceVersion: string; translationVersion: string; sentenceId: string; from: number; quote: string; sourceSpans: { from: number; to: number; quote: string }[] };
export type ReadingPosition = { workspace: string; layout: string; sentenceId: string | null; quote: string; from: number; translationVersion: string | null; scrollTop: number };
export type RecoveryRecord<T> = { schema: 1; writer: string; at: number; base: string; draft: T };
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** Separate window journals prevent one editor from overwriting another's recovery. */
export class EditorLocalStore {
  readonly prefix: string;
  constructor(private readonly storage: StorageLike, scope: string, readonly writer: string) { this.prefix = `munhae.editor.v1:${encodeURIComponent(scope)}:`; }
  read<T>(name: string): T | null {
    const raw = this.storage.getItem(this.prefix + name);
    if (raw === null) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }
  write(name: string, value: unknown): void { this.storage.setItem(this.prefix + name, JSON.stringify(value)); }
  remove(name: string): void { this.storage.removeItem(this.prefix + name); }
  recoveries<T>(valid: (value: unknown) => value is T): RecoveryRecord<T>[] {
    const records: RecoveryRecord<T>[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(this.prefix + "recovery:")) continue;
      const record = this.read<RecoveryRecord<unknown>>(key.slice(this.prefix.length));
      if (record?.schema === 1 && typeof record.writer === "string" && typeof record.at === "number" && typeof record.base === "string" && valid(record.draft)) records.push(record as RecoveryRecord<T>);
    }
    return records.sort((a, b) => b.at - a.at);
  }
  recover<T>(base: string, draft: T): void { this.write(`recovery:${this.writer}`, { schema: 1, writer: this.writer, at: Date.now(), base, draft }); }
  clearRecovery(writer = this.writer): void { this.remove(`recovery:${writer}`); }
}

/** Match only known coordinates or a unique unchanged quote, never a first guess. */
export function findReviewPlace(place: Pick<ReviewPlace, "sentenceId" | "from" | "quote">, sentences: { id: string; from: number; text: string }[]): string | null {
  const exact = sentences.find(sentence => sentence.id === place.sentenceId && sentence.from === place.from && sentence.text === place.quote);
  if (exact) return exact.id;
  const matches = sentences.filter(sentence => sentence.text === place.quote);
  return matches.length === 1 ? matches[0]!.id : null;
}

export function whitespaceMarkup(text: string, escape: (text: string) => string): string {
  // Text nodes still contain the original characters. Markers are CSS pseudo-elements.
  return text.split(/([ \t\n\r])/).map(part => part === " " ? '<span class="ws-space"> </span>' : part === "\t" ? '<span class="ws-tab">\t</span>' : part === "\n" ? '<span class="ws-newline">\n</span>' : escape(part)).join("");
}
