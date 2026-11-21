import { z } from 'zod';

export const appearance = z.enum([
  'petrol',
  'midnight',
  'bronze',
  'titanium',
  'graphite',
  'forest',
  'aubergine',
  'arctic',
  'rosewood',
  'ink',
]);
export type Appearance = z.infer<typeof appearance>;
export const appearanceNames: Record<Appearance, string> = {
  petrol: 'Petrol',
  midnight: 'Midnight',
  bronze: 'Smoked Bronze',
  titanium: 'Titanium',
  graphite: 'Graphite',
  forest: 'Forest',
  aubergine: 'Aubergine',
  arctic: 'Arctic',
  rosewood: 'Rosewood',
  ink: 'Ink',
};

// The accent colours buttons, selection outlines and other highlights. Neutral keeps the
// theme's own light grey.
export const accent = z.enum([
  'neutral',
  'blue',
  'teal',
  'green',
  'amber',
  'coral',
  'rose',
  'violet',
]);
export type Accent = z.infer<typeof accent>;
export const accentNames: Record<Accent, string> = {
  neutral: 'Neutral',
  blue: 'Blue',
  teal: 'Teal',
  green: 'Green',
  amber: 'Amber',
  coral: 'Coral',
  rose: 'Rose',
  violet: 'Violet',
};
