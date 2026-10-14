import React from 'react';
import { useBookStore } from '../../store/bookStore';
import { BookView } from './BookView';
import { PdfBookView } from './PdfBookView';
import { PagedTextView } from './PagedTextView';
import { PagedBookBar } from './PagedBookBar';

/**
 * Экран книги: один для текста и PDF. Какой вид показать, решает он сам;
 * оболочка приложения только вставляет его, когда книга открыта.
 */
export const BookScreen: React.FC = () => {
  const currentBook = useBookStore((state) => state.currentBook);
  const pdfViewMode = useBookStore((state) => state.pdfViewMode);
  if (!currentBook) return null;
  const showPdfOriginal = Boolean(currentBook.rawPdfBuffer) && pdfViewMode === 'original';
  const id = currentBook.metadata.id;
  return (
    <>
      {currentBook.metadata.paged && <PagedBookBar />}
      {showPdfOriginal ? <PdfBookView key={id} /> : currentBook.metadata.paged ? <PagedTextView key={id} /> : <BookView key={id} />}
    </>
  );
};
