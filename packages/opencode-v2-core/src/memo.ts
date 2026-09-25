import type { Hash } from "node:crypto";
import type { NativeSegmentCreate } from "@reflection/shared/native";
import type { SourceInfo } from "@reflection/shared/sources";
import type { NativeCanonicalRecord } from "./history.js";

/**
 * Raw-prefix hash state after a segment. It is valid only when the previous
 * segment's link is this exact object (null for the first segment). A
 * recomputed link is a new object, so every later link built on the old one
 * stops matching: the chain is checked transitively, not just one step back.
 */
export interface NativePrefixLink {
  readonly previous: NativePrefixLink | null;
  readonly hash: Hash;
  readonly fingerprint: string;
}

export interface NativeSegmentMemoEntry {
  readonly records: readonly NativeCanonicalRecord[];
  /** Frozen canonical request; identity marks a planned segment as known. */
  readonly request: NativeSegmentCreate;
  readonly id: string;
  readonly fingerprint: string;
  readonly textChars: number;
  prefix?: NativePrefixLink;
}

const ENTRIES_PER_START = 8;

/**
 * Per-segment results reused across projection steps of one plugin instance.
 *
 * Entries are keyed by record object identity. A hit requires every record in
 * the slice to be the same object, so callers must never mutate canonical
 * records. Any re-read history produces new objects and simply misses. The
 * WeakMap releases entries once their records are no longer referenced.
 */
export class NativeSegmentMemo {
  readonly #entries = new WeakMap<
    NativeCanonicalRecord,
    { key: string; entry: NativeSegmentMemoEntry }[]
  >();

  lookup(
    source: SourceInfo,
    sessionId: string,
    records: readonly NativeCanonicalRecord[],
  ): NativeSegmentMemoEntry | undefined {
    const first = records[0];
    if (first === undefined) return undefined;
    const key = keyOf(source, sessionId);
    return this.#entries
      .get(first)
      ?.find(
        (item) =>
          item.key === key &&
          item.entry.records.length === records.length &&
          item.entry.records.every(
            (record, index) => record === records[index],
          ),
      )?.entry;
  }

  remember(
    source: SourceInfo,
    sessionId: string,
    records: readonly NativeCanonicalRecord[],
    result: Pick<NativeSegmentMemoEntry, "request" | "id" | "fingerprint">,
    textChars: number,
  ): NativeSegmentMemoEntry {
    const first = records[0];
    if (first === undefined) throw new Error("cannot memoize an empty segment");
    const existing = this.lookup(source, sessionId, records);
    if (existing) return existing;
    const entry: NativeSegmentMemoEntry = {
      records: [...records],
      request: freezeRequest(result.request),
      id: result.id,
      fingerprint: result.fingerprint,
      textChars,
    };
    const list = this.#entries.get(first) ?? [];
    list.push({ key: keyOf(source, sessionId), entry });
    if (list.length > ENTRIES_PER_START) list.shift();
    this.#entries.set(first, list);
    return entry;
  }
}

function keyOf(source: SourceInfo, sessionId: string): string {
  return JSON.stringify([
    source.id,
    source.kind,
    source.identity_scheme,
    sessionId,
  ]);
}

// Messages may be the records' own source objects, which are immutable by
// contract; freeze only the request structure the memo owns.
function freezeRequest(request: NativeSegmentCreate): NativeSegmentCreate {
  Object.freeze(request.messages);
  return Object.freeze(request);
}
