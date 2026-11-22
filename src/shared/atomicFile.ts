import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Substitui o conteudo de um arquivo de forma atomica: o conteudo completo vai
 * para um temporario no mesmo diretorio, e so depois o rename publica o
 * resultado sobre o destino. Quem le durante a troca ve o arquivo antigo ou o
 * novo, nunca um arquivo vazio ou parcial; se a gravacao ou a troca falhar (ou
 * o processo morrer no meio), o destino segue com o conteudo antigo. Sem
 * regravacao direta de reserva: ela e justamente o que trunca o arquivo antes
 * de escrever. Lanca em qualquer falha; o temporario nunca fica para tras.
 */
export function writeFileAtomically(targetPath: string, body: string): void {
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    const descriptor = openSync(tempPath, "w");

    try {
      writeFileSync(descriptor, body, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }

    renameSync(tempPath, targetPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}
