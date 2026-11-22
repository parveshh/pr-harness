import { z } from 'zod';
import type { FileInfo } from './reader.js';
import { pullRequestUrl } from './reviews.js';

export const lessonKey = z.object({
  sourceUrl: pullRequestUrl,
  threadId: z.number().int().positive(),
});
export const saveLesson = lessonKey.extend({
  note: z.string().trim().min(1).max(2000),
  fragment: z
    .string()
    .max(160)
    .regex(/^[^\r\n]*$/)
    .transform((value) => (value.trim() ? value : '')),
});
export const reviewLesson = saveLesson.extend({ path: z.string().min(1) });
export type SaveLesson = z.infer<typeof saveLesson>;
export type ReviewLesson = z.infer<typeof reviewLesson>;
export type LessonKey = z.infer<typeof lessonKey>;

export function matchesLessonLines(lesson: ReviewLesson, lines: readonly string[]) {
  if (!lesson.fragment) return false;
  return lines.some(
    (line) =>
      (line.startsWith('+') || line.startsWith('-')) && line.slice(1).includes(lesson.fragment),
  );
}

export function matchesLessonFile(
  lesson: ReviewLesson,
  file: Pick<FileInfo, 'path' | 'previousPath' | 'status'>,
) {
  return (
    !lesson.fragment &&
    (lesson.path === file.path || (file.status === 'renamed' && lesson.path === file.previousPath))
  );
}
