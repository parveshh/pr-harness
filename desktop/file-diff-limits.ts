// Interactive file reads have their own budget. Model source lookups keep their smaller limit.
export const reviewFileBytes = 16 * 1024 * 1024;
export const reviewDiffBytes = 4 * reviewFileBytes + 65536;
export const fullContext = '--unified=' + reviewFileBytes;
