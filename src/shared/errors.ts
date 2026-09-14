import type { ApiErrorBody } from "./types.ts";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export const EXIT_FAILURE = 1;
export const EXIT_UNCERTAIN_RESULT = 2;

/**
 * Exit code coerente com o resultado real: 0 e sucesso (caminho feliz), 1 e
 * falha confirmada sem transmissao, 2 e resultado incerto — o envio pode ter
 * acontecido e o chamador precisa conferir o historico antes de reagir.
 */
export function exitCodeForError(error: unknown): number {
  if (isAppError(error) && error.code === "SEND_RESULT_UNCERTAIN") {
    return EXIT_UNCERTAIN_RESULT;
  }

  return EXIT_FAILURE;
}

export function toApiErrorBody(error: unknown): ApiErrorBody {
  if (isAppError(error)) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unexpected error"
    }
  };
}
