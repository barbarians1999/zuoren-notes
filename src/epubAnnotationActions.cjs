function updateAnnotationComment(annotations, annotationId, comment, updatedAt) {
  const trimmed = comment.trim();
  return annotations.map(annotation => {
    if (annotation.id !== annotationId) return annotation;
    const updated = { ...annotation, updatedAt };
    if (trimmed) updated.comment = trimmed;
    else delete updated.comment;
    return updated;
  });
}

function annotationExcerpt(epubId, annotation) {
  return {
    anchor: {
      epubId,
      cfiRange: annotation.cfiRange,
      quote: annotation.quote,
      annotationId: annotation.id,
      chapterHref: annotation.chapterHref,
      chapterLabel: annotation.chapterLabel,
    },
    quote: annotation.quote,
    comment: annotation.comment || '',
  };
}

module.exports = { updateAnnotationComment, annotationExcerpt };
