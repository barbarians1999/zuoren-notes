import type { EpubAnchor, EpubAnnotation } from './types';
export function updateAnnotationComment(annotations: EpubAnnotation[], annotationId: string, comment: string, updatedAt: string): EpubAnnotation[];
export function annotationExcerpt(epubId: string, annotation: EpubAnnotation): { anchor: EpubAnchor; quote: string; comment: string };
