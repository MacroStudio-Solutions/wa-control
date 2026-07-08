declare module "qrcode-terminal" {
  interface QrOptions {
    small?: boolean;
  }

  interface QrTerminalApi {
    error: unknown;
    generate(input: string, callback: (output: string) => void): void;
    generate(input: string, options: QrOptions, callback: (output: string) => void): void;
    setErrorLevel(level: string): void;
  }

  const api: QrTerminalApi;
  export default api;
}
