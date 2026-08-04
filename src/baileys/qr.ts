import qrcode from "qrcode-terminal";
import QRCode from "qrcode";

export function renderQrTerminal(qr: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(qr, { small: true }, (output) => {
      resolve(output);
    });
  });
}

/**
 * Data URL PNG do mesmo payload que o terminal desenha.
 *
 * O QR do WhatsApp vale por poucos segundos e nao deveria sair da maquina,
 * entao a imagem viaja embutida na resposta: quem consome — uma view do Studio,
 * por exemplo — exibe direto, sem intermediario e sem servico de terceiros.
 */
export function renderQrDataUrl(qr: string): Promise<string> {
  return QRCode.toDataURL(qr, {
    errorCorrectionLevel: "L",
    margin: 2,
    scale: 6
  });
}

export function dataUrlToBase64(dataUrl: string): string {
  const marker = "base64,";
  const index = dataUrl.indexOf(marker);
  return index === -1 ? dataUrl : dataUrl.slice(index + marker.length);
}
