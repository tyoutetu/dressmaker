export type GenErrorCode =
  | "bad_request"
  | "invalid_npc"
  | "invalid_image"
  | "limit_reached"
  | "quota_unavailable"
  | "rate_limit"
  | "provider_error"
  | "timeout"
  | "safety_rejection"
  | "service_unavailable"
  | "not_found"
  | "forbidden_origin"
  | "method_not_allowed"
  | "unknown";

export class ApiError extends Error {
  constructor(
    public code: GenErrorCode,
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Short, user-safe messages for each error code (details stay server-side). */
export const USER_MESSAGES: Record<GenErrorCode, string> = {
  bad_request: "The request was incomplete. Please reload the page and try again.",
  invalid_npc: "That customer is not available right now. Please pick another one.",
  invalid_image:
    "That image didn't pass our checks. Please use a clear JPEG, PNG or WebP game screenshot under 4 MB.",
  limit_reached: "Today's preview limit has been reached. It refreshes at 00:00 UTC.",
  quota_unavailable:
    "The preview limit service is unavailable right now, so no preview was started. Please try again later.",
  rate_limit: "The AI service is busy right now. Please wait a minute and try again.",
  provider_error: "The AI service could not finish this preview.",
  timeout: "The AI service did not answer in time, so the preview was stopped.",
  safety_rejection:
    "The AI declined this image. Please try a different dress screenshot.",
  service_unavailable: "The preview service is not fully set up yet. Please try again later.",
  not_found: "That generation could not be found.",
  forbidden_origin: "This API cannot be called from that origin.",
  method_not_allowed: "Method not allowed.",
  unknown: "Something went wrong. Please try again.",
};
