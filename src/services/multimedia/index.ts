// 지시 #9c2ae902 · 멀티미디어 어댑터 공개 API 배럴.
// UI(미디어 허브) 와 서버 엔드포인트는 본 파일 하나만 import 해도 충분하도록,
// 타입·어댑터 팩토리·레지스트리를 모두 재수출한다.

export * from './types';
export { createPdfAdapter } from './PdfAdapter';
export {
  PdfAdapter,
  createRealPdfAdapter,
  parsePdf,
  generatePdf,
  PDF_ADAPTER_ID,
  type ParsedPdf,
  type PdfPage,
  type PdfImageRef,
  type PdfMetadata,
  type DocumentTree,
  type DocumentSection,
  type DocumentNode,
  type PdfParseDriver,
  type PdfGenerateDriver,
  type PdfAdapterErrorCode,
  type ParsePdfOptions,
  type GeneratePdfOptions,
  type RealPdfAdapterOptions,
} from './adapters/PdfAdapter';
export { createPptAdapter, PPT_ADAPTER_ID } from './PptAdapter';
export { createVideoAdapter, VIDEO_ADAPTER_ID } from './VideoAdapter';
export { createWebSearchAdapter, WEB_SEARCH_ADAPTER_ID } from './WebSearchAdapter';
export { createResearchAdapter, RESEARCH_ADAPTER_ID } from './ResearchAdapter';
export {
  createInputAutomationAdapter,
  INPUT_AUTOMATION_ADAPTER_ID,
} from './InputAutomationAdapter';
export {
  MultimediaRegistry,
  createDefaultRegistry,
  type MultimediaRegistryOptions,
} from './MultimediaRegistry';
