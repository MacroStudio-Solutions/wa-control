/**
 * A ordem de nomes que a tela de sessoes sempre usou: principal, session-2,
 * session-3, ... A escolha do proximo nome livre vive aqui, no programa, e nao
 * numa casca de shell (grep/cut) — Windows sem bash cria sessao do mesmo jeito.
 */
export const FIRST_SESSION_NAME = "principal";

export function nextFreeSessionName(existingIds: string[]): string {
  const taken = new Set(existingIds);

  if (!taken.has(FIRST_SESSION_NAME)) {
    return FIRST_SESSION_NAME;
  }

  for (let index = 2; ; index++) {
    const name = `session-${index}`;
    if (!taken.has(name)) {
      return name;
    }
  }
}
