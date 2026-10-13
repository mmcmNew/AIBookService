/**
 * Navigation commands (UI -> Domain -> State).
 * Writes st_position on behalf of b_dom_coord,
 * and st_paged on behalf of b_dom_pdf.
 */
import { coordinator } from './audio/coordinator';
import { setFocusPage as setPagedFocusPage } from './pdf/pagedSession';

export function setChapterIndex(index: number): void {
  coordinator.setChapterIndex(index);
}

export function setViewPage(page: number): void {
  coordinator.setViewPage(page);
}

export function goToPage(page: number): void {
  coordinator.goToPage(page);
}

export function setFocusPage(page: number): void {
  setPagedFocusPage(page);
}

export async function jumpToSentence(sentenceId: number): Promise<void> {
  await coordinator.jumpToSentence(sentenceId);
}
