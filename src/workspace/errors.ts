export type WorkspaceErrorCode =
  | "INVALID_PATH"
  | "PATH_OUTSIDE_WORKSPACE"
  | "ACCESS_DENIED_SENSITIVE_FILE"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "FILE_CHANGED";

export class WorkspaceError extends Error {
  constructor(public code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}
