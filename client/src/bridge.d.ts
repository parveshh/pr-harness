import type { ReviewerBridge } from '../../shared/reviews.js';
declare global {
  interface Window {
    readonly reviewer: ReviewerBridge;
  }
}
