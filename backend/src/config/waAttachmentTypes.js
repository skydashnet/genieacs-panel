/**
 * Os tipos de arquivo que o operador pode mandar pelo WhatsApp, numa lista só.
 *
 * Três lados leem esta lista, e ela existe para que os três não divirjam:
 * - o upload (`waAttachmentService.js`), que recusa o que não está aqui e
 *   confere os primeiros bytes do arquivo contra o tipo declarado;
 * - o envio (`waSendService.js`), que manda como `image`, `video`, `audio` ou
 *   `document` — o `kind` de cada linha;
 * - a tela (`frontend/src/lib/wa-attachments.ts`), que espelha a lista e tem um
 *   teste de paridade que importa ESTE arquivo.
 *
 * O que fica de fora, de propósito: HTML, SVG, JavaScript e executáveis. Um
 * arquivo desses chegando ao celular do assinante com o nome do provedor é o
 * golpe pronto; e servido pelo painel, é script rodando no endereço dele.
 *
 * `extensions`: a primeira é a que o arquivo ganha no disco — a extensão vem
 * daqui, nunca do nome que o navegador mandou. As outras servem só para a tela
 * reconhecer o arquivo quando o navegador não diz o tipo (o Windows manda CSV
 * como `application/vnd.ms-excel`, e a foto do iPhone chega sem tipo nenhum).
 *
 * `convertTo`: o tipo que o painel converte antes de guardar. A foto HEIC do
 * iPhone vira JPEG, porque o Android do assinante não abre HEIC.
 */
export const ATTACHMENT_TYPES = Object.freeze([
  { type: 'image/jpeg', extensions: ['.jpg', '.jpeg'], kind: 'image' },
  { type: 'image/png', extensions: ['.png'], kind: 'image' },
  { type: 'image/webp', extensions: ['.webp'], kind: 'image' },
  { type: 'image/gif', extensions: ['.gif'], kind: 'image' },
  { type: 'image/heic', extensions: ['.heic', '.heif'], kind: 'image', convertTo: 'image/jpeg' },
  { type: 'application/pdf', extensions: ['.pdf'], kind: 'document' },
  { type: 'application/msword', extensions: ['.doc'], kind: 'document' },
  {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['.docx'],
    kind: 'document'
  },
  { type: 'application/vnd.ms-excel', extensions: ['.xls'], kind: 'document' },
  {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['.xlsx'],
    kind: 'document'
  },
  { type: 'text/plain', extensions: ['.txt'], kind: 'document' },
  { type: 'text/csv', extensions: ['.csv'], kind: 'document' },
  { type: 'application/zip', extensions: ['.zip'], kind: 'document' },
  { type: 'video/mp4', extensions: ['.mp4'], kind: 'video' },
  { type: 'audio/ogg', extensions: ['.ogg', '.oga'], kind: 'audio' },
  { type: 'audio/mpeg', extensions: ['.mp3'], kind: 'audio' },
  // O que os navegadores gravam: o Chrome em WebM/Opus, o Safari em MP4/AAC.
  // Vão pela rota de voz do Evolution v2, que converte para OGG/Opus.
  { type: 'audio/webm', extensions: ['.webm'], kind: 'audio' },
  { type: 'audio/mp4', extensions: ['.m4a'], kind: 'audio' }
]);

/**
 * Nomes que navegadores e sistemas dão ao mesmo tipo. Lidos como o tipo da
 * lista; nunca o contrário.
 */
export const ATTACHMENT_TYPE_ALIASES = Object.freeze({
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/heif': 'image/heic',
  'application/x-zip-compressed': 'application/zip',
  'audio/mp3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'application/csv': 'text/csv'
});

/** O teto de um arquivo, em MB. O mesmo que o WhatsApp aceita para mídia comum. */
export const MAX_ATTACHMENT_MB = 16;

/** Quantos arquivos o operador escolhe de uma vez. Cada um vira uma mensagem. */
export const MAX_ATTACHMENTS_PER_SEND = 10;
