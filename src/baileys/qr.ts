import qrcode from "qrcode-terminal";

export function renderQrTerminal(qr: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(qr, { small: true }, (output) => {
      resolve(output);
    });
  });
}
