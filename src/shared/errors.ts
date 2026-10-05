export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown[] = [],
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (resource: string): AppError =>
  new AppError(404, "NOT_FOUND", `${resource} was not found.`);

export const forbidden = (): AppError =>
  new AppError(403, "FORBIDDEN", "You do not have permission to perform this action.");

export const unauthorized = (): AppError =>
  new AppError(401, "UNAUTHORIZED", "Authentication is required.");

// Prisma error messages can quote the query arguments, which hold customer data, so only their
// type and code reach the logs.
export function loggableError(error: unknown): unknown {
  if (!(error instanceof Error) || !error.name.startsWith("PrismaClient")) return error;
  const code = (error as { code?: unknown }).code;
  return { type: error.name, ...(typeof code === "string" ? { code } : {}) };
}
