import { FFIType, dlopen, ptr } from "bun:ffi";

/**
 * Filho destacado, independente da plataforma: o pid, o codigo de saida quando
 * ele ja morreu (null enquanto vive) e a liberacao do que o pai segura dele.
 */
export interface DetachedChild {
  pid: number;
  exitCode(): number | null;
  release(): void;
}

export interface WindowsSpawnOptions {
  command: string[];
  env: Record<string, string>;
  logPath: string;
}

const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
const STILL_ACTIVE = 259;
const ERROR_ACCESS_DENIED = 5;

const FILE_APPEND_DATA = 0x4;
const FILE_WRITE_ATTRIBUTES = 0x100;
const SYNCHRONIZE = 0x100000;
const GENERIC_READ = 0x80000000;
const FILE_SHARE_ALL = 0x7;
const FILE_SHARE_READ_WRITE = 0x3;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_NORMAL = 0x80;

const STARTF_USESHOWWINDOW = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const SW_HIDE = 0;

const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const DETACHED_PROCESS = 0x8;
const CREATE_NEW_PROCESS_GROUP = 0x200;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_BREAKAWAY_FROM_JOB = 0x1000000;

const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002n;

const STARTUPINFOEX_SIZE = 112;
const STARTUP_ATTRIBUTE_LIST_OFFSET = 104;
const PROCESS_INFORMATION_SIZE = 24;
const SECURITY_ATTRIBUTES_SIZE = 24;

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

function quoteArgument(argument: string): string {
  return `"${argument.replace(/"/g, '\\"')}"`;
}

function buildEnvironmentBlock(env: Record<string, string>): Buffer {
  const entries = Object.entries(env)
    .filter(([key]) => key.length > 0 && !key.startsWith("="))
    .sort(([left], [right]) => left.toUpperCase().localeCompare(right.toUpperCase()));

  return Buffer.from(`${entries.map(([key, value]) => `${key}=${value}`).join("\0")}\0\0`, "utf16le");
}

/**
 * Cria o daemon com CreateProcessW e uma lista explicita de handles
 * herdaveis (PROC_THREAD_ATTRIBUTE_HANDLE_LIST): so o NUL do stdin e o
 * daemon.log, aberto em modo de acrescimo (FILE_APPEND_DATA, sem
 * FILE_WRITE_DATA, entao cada escrita vai ao fim do arquivo). O spawn comum do
 * Bun cria o filho destacado com heranca de TODOS os handles herdaveis do
 * pai, o que faz o daemon segurar aberto o pipe de stdout de quem chamou o
 * verbo (o Studio, um terminal): quem le a saida ate o fim ficaria esperando
 * o daemon morrer. Sem janela (DETACHED_PROCESS nao anexa console e
 * SW_HIDE cobre o resto), em grupo de processos proprio, e fora do job do
 * pai quando o job permite.
 */
export async function spawnDetachedWindows(options: WindowsSpawnOptions): Promise<DetachedChild> {
  const kernel32 = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.u64
      ],
      returns: FFIType.u64
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    InitializeProcThreadAttributeList: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32
    },
    UpdateProcThreadAttribute: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u64,
        FFIType.ptr,
        FFIType.u64,
        FFIType.ptr,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr
      ],
      returns: FFIType.i32
    },
    GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 }
  });
  const api = kernel32.symbols;

  const security = Buffer.alloc(SECURITY_ATTRIBUTES_SIZE);
  security.writeUInt32LE(SECURITY_ATTRIBUTES_SIZE, 0);
  security.writeUInt32LE(1, 16);

  const openHandle = (path: string, access: number, share: number, disposition: number) => {
    const handle = BigInt(
      api.CreateFileW(wide(path), access, share, security, disposition, FILE_ATTRIBUTE_NORMAL, 0n)
    );

    if (handle === INVALID_HANDLE_VALUE) {
      throw new Error(`CreateFileW(${path}) falhou (erro ${api.GetLastError()})`);
    }

    return handle;
  };

  const logHandle = openHandle(
    options.logPath,
    FILE_APPEND_DATA | FILE_WRITE_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_ALL,
    OPEN_ALWAYS
  );
  let nulHandle: bigint | null = null;
  let attributeList: Buffer | null = null;

  try {
    nulHandle = openHandle("NUL", GENERIC_READ, FILE_SHARE_READ_WRITE, OPEN_EXISTING);

    const sizeBuffer = new BigUint64Array(1);
    api.InitializeProcThreadAttributeList(null, 1, 0, sizeBuffer);
    attributeList = Buffer.alloc(Number(sizeBuffer[0]));

    if (!api.InitializeProcThreadAttributeList(attributeList, 1, 0, sizeBuffer)) {
      throw new Error(`InitializeProcThreadAttributeList falhou (erro ${api.GetLastError()})`);
    }

    const inheritable = new BigUint64Array([nulHandle, logHandle]);

    if (
      !api.UpdateProcThreadAttribute(
        attributeList,
        0,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        inheritable,
        BigInt(inheritable.byteLength),
        null,
        null
      )
    ) {
      throw new Error(`UpdateProcThreadAttribute falhou (erro ${api.GetLastError()})`);
    }

    const startup = Buffer.alloc(STARTUPINFOEX_SIZE);
    startup.writeUInt32LE(STARTUPINFOEX_SIZE, 0);
    startup.writeUInt32LE(STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, 60);
    startup.writeUInt16LE(SW_HIDE, 64);
    startup.writeBigUInt64LE(nulHandle, 80);
    startup.writeBigUInt64LE(logHandle, 88);
    startup.writeBigUInt64LE(logHandle, 96);
    startup.writeBigUInt64LE(BigInt(ptr(attributeList)), STARTUP_ATTRIBUTE_LIST_OFFSET);

    const environment = buildEnvironmentBlock(options.env);
    const commandLine = wide(options.command.map(quoteArgument).join(" "));
    const baseFlags =
      EXTENDED_STARTUPINFO_PRESENT |
      DETACHED_PROCESS |
      CREATE_NEW_PROCESS_GROUP |
      CREATE_UNICODE_ENVIRONMENT;

    const create = (flags: number) => {
      const info = Buffer.alloc(PROCESS_INFORMATION_SIZE);
      const created = api.CreateProcessW(
        null,
        commandLine,
        null,
        null,
        1,
        flags,
        environment,
        null,
        startup,
        info
      );
      return { created: created !== 0, info, error: created === 0 ? api.GetLastError() : 0 };
    };

    let attempt = create(baseFlags | CREATE_BREAKAWAY_FROM_JOB);

    if (!attempt.created && attempt.error === ERROR_ACCESS_DENIED) {
      attempt = create(baseFlags);
    }

    if (!attempt.created) {
      throw new Error(`CreateProcessW falhou (erro ${attempt.error})`);
    }

    const processHandle = attempt.info.readBigUInt64LE(0);
    const threadHandle = attempt.info.readBigUInt64LE(8);
    const pid = attempt.info.readUInt32LE(16);
    api.CloseHandle(threadHandle);

    return {
      pid,
      exitCode() {
        const code = new Uint32Array(1);
        const ok = api.GetExitCodeProcess(processHandle, code);
        const value = code[0] ?? STILL_ACTIVE;
        return ok && value !== STILL_ACTIVE ? value : null;
      },
      release() {
        api.CloseHandle(processHandle);
      }
    };
  } finally {
    if (attributeList) {
      api.DeleteProcThreadAttributeList(attributeList);
    }

    api.CloseHandle(logHandle);

    if (nulHandle !== null) {
      api.CloseHandle(nulHandle);
    }
  }
}
