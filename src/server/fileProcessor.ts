import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export type DirectiveFileType = 'pdf' | 'image' | 'text';

export interface DirectiveFileRecord {
  fileId: string;
  name: string;
  type: DirectiveFileType;
  extractedText: string;
  images: string[];
}

const TEXT_EXT = new Set(['.txt', '.md', '.json', '.csv', '.log', '.yaml', '.yml', '.html', '.xml']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function inferType(name: string, mimeType?: string): DirectiveFileType {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf' || mimeType === 'application/pdf') return 'pdf';
  if (IMAGE_EXT.has(ext) || (mimeType && mimeType.startsWith('image/'))) return 'image';
  if (TEXT_EXT.has(ext) || (mimeType && mimeType.startsWith('text/'))) return 'text';
  return 'text';
}

function mimeForImageExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    default: return 'application/octet-stream';
  }
}

async function extractPdf(buffer: Buffer): Promise<{ extractedText: string; images: string[] }> {
  // pdf-parse v2 는 기본 export 함수가 아니라 `PDFParse` 클래스 기반 API. 생성자에
  // { data: Uint8Array } 를 넘기고 getText() / destroy() 를 호출한다. v1 의
  // `pdfParse(buffer)` 호출 시그니처는 더 이상 존재하지 않아 'pdfParse is not a function'
  // 런타임 오류를 낸다.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let extractedText = '';
  try {
    const textResult = await parser.getText();
    extractedText = textResult?.text ?? '';
  } finally {
    await parser.destroy?.();
  }

  const images: string[] = [];
  try {
    // pdfjs 의 레거시 빌드는 Node 에서 DOMMatrix/Canvas polyfill 없이 구동 가능.
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const canvasMod: any = await import('canvas');
    const { createCanvas } = canvasMod;
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      useSystemFonts: false,
    });
    const doc = await loadingTask.promise;
    const pageCount: number = doc.numPages;
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
      const b64 = canvas.toBuffer('image/png').toString('base64');
      images.push(`data:image/png;base64,${b64}`);
    }
  } catch (e) {
    console.warn('[fileProcessor] pdf render skipped:', (e as Error).message);
  }

  return { extractedText, images };
}

function extractImage(buffer: Buffer, name: string, mimeType?: string): { extractedText: string; images: string[] } {
  const mime = mimeType || mimeForImageExt(path.extname(name));
  const b64 = buffer.toString('base64');
  return { extractedText: '', images: [`data:${mime};base64,${b64}`] };
}

function extractText(buffer: Buffer): { extractedText: string; images: string[] } {
  return { extractedText: buffer.toString('utf8'), images: [] };
}

export interface ProcessInput {
  projectId: string;
  originalName: string;
  buffer: Buffer;
  mimeType?: string;
  dataRoot?: string;
}

export async function processDirectiveFile(input: ProcessInput): Promise<DirectiveFileRecord> {
  const { projectId, originalName, buffer, mimeType } = input;
  const root = input.dataRoot || path.resolve(process.cwd(), 'data', 'uploads');
  const dir = path.join(root, projectId);
  mkdirSync(dir, { recursive: true });

  const type = inferType(originalName, mimeType);
  const fileId = uuidv4();
  let payload: { extractedText: string; images: string[] };
  if (type === 'pdf') {
    // pdf-parse / pdfjs 가 던지는 파서 에러는 업로드 실패로 확대하지 않는다.
    // 파일명·type 메타는 유지하고 추출본을 비워 돌려, 사용자가 같은 PDF 를
    // "파일명만이라도" 지시에 첨부해 이어갈 수 있도록 한다. 원인 추적용으로
    // 전체 스택은 경고 로그에 남긴다 (upload 핸들러는 성공 응답 반환).
    try {
      payload = await extractPdf(buffer);
    } catch (e) {
      console.warn(
        '[fileProcessor] pdf extract failed, falling back to empty payload:',
        (e as Error)?.stack || (e as Error)?.message || e,
      );
      payload = { extractedText: '', images: [] };
    }
  } else if (type === 'image') {
    payload = extractImage(buffer, originalName, mimeType);
  } else {
    payload = extractText(buffer);
  }

  const record: DirectiveFileRecord = {
    fileId,
    name: originalName,
    type,
    extractedText: payload.extractedText,
    images: payload.images,
  };
  const jsonPath = path.join(dir, `${fileId}.json`);
  writeFileSync(jsonPath, JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function loadDirectiveRecord(projectId: string, fileId: string, dataRoot?: string): DirectiveFileRecord {
  const root = dataRoot || path.resolve(process.cwd(), 'data', 'uploads');
  const jsonPath = path.join(root, projectId, `${fileId}.json`);
  return JSON.parse(readFileSync(jsonPath, 'utf8')) as DirectiveFileRecord;
}
