import type { BookRecord } from '../types';

/** Virtual shelf entry: showcases the workspace with the built-in sample text. */
export const DEMO_BOOK: BookRecord = {
  id: '__demo__',
  title: 'Hamlet · Act III, Scene 1',
  author: 'William Shakespeare',
  format: 'epub',
  filePath: '',
  coverPath: null,
  totalParagraphs: 0,
  addedAt: 0,
  lastOpenedAt: null,
  progress: 0,
  locator: null,
};
