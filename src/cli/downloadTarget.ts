import { accessSync, existsSync, statSync, constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { AppError } from "../shared/errors.ts";
import { extensionForMimeType } from "../media/mediaInference.ts";

export interface DownloadTarget {
  /** Diretorio que recebera o arquivo. */
  directory: string;
  /** Nome concreto quando --out foi dado; null = derivar de messageId + MIME. */
  fileName: string | null;
}

function invalidOutput(message: string, details: Record<string, unknown>): AppError {
  return new AppError("INVALID_OUTPUT", 400, message, details);
}

/**
 * Resolve o destino ANTES de qualquer fetch: com --out separa diretorio e nome;
 * sem --out, o diretorio corrente com nome derivado depois do MIME responder.
 */
export function resolveDownloadTarget(out: string | undefined, messageId: string): DownloadTarget {
  if (out === undefined) {
    return {
      directory: process.cwd(),
      fileName: null
    };
  }

  if (!out.trim()) {
    throw invalidOutput("Caminho vazio em --out.", { out });
  }

  const resolved = isAbsolute(out) ? resolve(out) : resolve(process.cwd(), out);

  if (out.endsWith("/") || out.endsWith("\\")) {
    throw invalidOutput(
      "--out aponta para um diretorio. Informe o caminho completo do arquivo, ex.: --out ./foto.jpg",
      { out }
    );
  }

  return {
    directory: dirname(resolved),
    fileName: basename(resolved)
  };
}

/** Pre-validacao do destino: falha aqui economiza o fetch e evita escrita parcial. */
export function assertDirectoryWritable(directory: string): void {
  if (!existsSync(directory)) {
    throw invalidOutput(`Diretorio de destino nao existe: '${directory}'.`, { directory });
  }

  if (!statSync(directory).isDirectory()) {
    throw invalidOutput(`Destino nao e um diretorio: '${directory}'.`, { directory });
  }

  try {
    accessSync(directory, fsConstants.W_OK);
  } catch {
    throw invalidOutput(`Sem permissao de escrita no diretorio de destino: '${directory}'.`, {
      directory
    });
  }
}

/**
 * --out apontando para um diretorio existente nao e um arquivo: rejeita antes
 * do fetch. Destino inexistente (arquivo novo) passa — o diretorio ja foi
 * validado por assertDirectoryWritable.
 */
export function assertConcreteDestination(target: DownloadTarget): void {
  if (!target.fileName || !existsSync(join(target.directory, target.fileName))) {
    return;
  }

  if (statSync(join(target.directory, target.fileName)).isDirectory()) {
    throw invalidOutput(
      `--out aponta para um diretorio existente: '${join(target.directory, target.fileName)}'. Informe o caminho de um arquivo.`,
      { directory: target.directory, fileName: target.fileName }
    );
  }
}

/**
 * Caminho final do arquivo: o nome de --out quando dado; caso contrario
 * <messageId saneado>.<extensao pelo MIME> no diretorio alvo.
 */
export function destinationPathFor(
  target: DownloadTarget,
  mimeType: string,
  messageId: string
): string {
  if (target.fileName) {
    return join(target.directory, target.fileName);
  }

  const name = sanitizeMessageIdForFile(messageId);
  return join(target.directory, `${name}.${extensionForMimeType(mimeType)}`);
}

/**
 * messageId vira nome de arquivo: mantem o que e seguro, substitui separadores
 * e caracteres arriscados — nunca deixa o id ditar caminho. Id que sara vazio,
 * so underscores ou reservado (".", "..") recebe fallback neutro.
 */
export function sanitizeMessageIdForFile(messageId: string): string {
  const sanitized = messageId.replace(/[^A-Za-z0-9._-]/g, "_");

  if (!sanitized || sanitized === "." || sanitized === ".." || /^_+$/.test(sanitized)) {
    return "media";
  }

  return sanitized;
}
