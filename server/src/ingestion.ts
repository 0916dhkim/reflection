import type {
  PersistedIngestRequest,
  IngestSegmentCreate,
} from "@reflection/shared/ingestion";
import type { PreparedSegment as LegacyPreparedSegment } from "@reflection/shared/domain";

export type PreparedSegment =
  | LegacyPreparedSegment
  | (Omit<
      LegacyPreparedSegment,
      | "sourceBoundaryVersion"
      | "startUserMessageId"
      | "endUserMessageId"
      | "startSourceMessageId"
      | "endSourceMessageId"
    > & {
      sourceBoundaryVersion: 3;
      startSourceMessageId: string;
      endSourceMessageId: string;
    });

export interface ExtractionSource {
  segmentId: string;
  request: PersistedIngestRequest;
}

// SQL NULL is the absence of a user boundary, never a manufactured user ID.
export function persistedBoundary(request: PersistedIngestRequest) {
  switch (request.source_boundary_version) {
    case 1:
    case 2:
      return {
        start_user_message_id: request.start_user_message_id,
        end_user_message_id: request.end_user_message_id,
      };
    case 3:
      return { start_user_message_id: null, end_user_message_id: null };
  }
}

export function persistedRequest(
  request: IngestSegmentCreate,
): PersistedIngestRequest {
  if (request.source_boundary_version === 3) return request;
  const { source_id: _owner, ...legacy } = request;
  return legacy;
}
